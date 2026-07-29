/**
 * Pre-dispatch / pre-chat CLI auth gate + Phase B notify / wait / resume.
 * Supports Cursor (coding) and Claude (chat / Grill-Me).
 *
 * Cursor DeepControl: keep `agent login` ALIVE after printing the URL —
 * killing it invalidates the challenge and browser approval does nothing.
 */

import { checkClaudeAuth, checkCursorAuth } from './health.js';
import { startClaudeLoginSession } from './claude-login-session.js';
import {
  hasActiveCursorLoginSession,
  startCursorLoginSession,
  waitForCursorLoginExit,
} from './cursor-login-session.js';
import { notifyCliAuthRequired } from './notify.js';
import { parkTask, removeParked } from './queue.js';

export const DEFAULT_AUTH_WAIT_MS = 1_800_000; // 30 min
export const DEFAULT_AUTH_POLL_MS = 8_000;

function probeFn(tool) {
  return tool === 'claude' ? checkClaudeAuth : checkCursorAuth;
}

function waitMsForTool(tool, env) {
  if (tool === 'claude') {
    const raw = env.CLI_AUTH_CLAUDE_WAIT_MS;
    if (raw != null && String(raw).trim() !== '') {
      return Number(raw);
    }
    return 0;
  }
  return Number(env.CLI_AUTH_WAIT_MS || DEFAULT_AUTH_WAIT_MS);
}

/**
 * Poll until CLI auth is healthy or timeout.
 * For Cursor, also watch the live login process exit.
 */
export async function waitForCliAuth({
  tool = 'cursor',
  onLog,
  env = process.env,
  timeoutMs = waitMsForTool(tool, env),
  intervalMs = Number(env.CLI_AUTH_POLL_MS || DEFAULT_AUTH_POLL_MS),
  signal,
  ...rest
} = {}) {
  const check = probeFn(tool);
  const started = Date.now();
  let attempt = 0;
  while (true) {
    if (signal?.aborted) {
      const err = new Error('CLI auth wait aborted');
      err.code = 'CLI_AUTH_ABORTED';
      throw err;
    }
    attempt += 1;

    if (tool === 'cursor' && hasActiveCursorLoginSession()) {
      const login = await waitForCursorLoginExit({ timeoutMs: 500 });
      if (login.ok) {
        onLog?.(
          `[cli-auth] cursor login process finished OK — re-probing status…`
        );
      } else if (login.running) {
        onLog?.(
          `[cli-auth] cursor login still waiting for browser approval (attempt=${attempt})`
        );
      }
    }

    const result = await check({ env, ...rest });
    if (result.ok) {
      onLog?.(
        `[cli-auth] ${tool} recovered after ${attempt} poll(s) (${Date.now() - started}ms)`
      );
      return result;
    }
    if (timeoutMs <= 0 || Date.now() - started >= timeoutMs) {
      return {
        ...result,
        ok: false,
        reason: `Timed out waiting for ${tool} CLI auth (${timeoutMs}ms): ${result.reason}`,
      };
    }
    onLog?.(
      `[cli-auth] waiting for ${tool} login… attempt=${attempt} status=${result.status}` +
        (tool === 'cursor' && hasActiveCursorLoginSession()
          ? ' (login process alive)'
          : '')
    );
    await new Promise((r) => setTimeout(r, Math.max(1000, intervalMs)));
  }
}

/**
 * @param {'cursor'|'claude'} [tool]
 * @param {object} [opts]
 */
export async function assertCliAuthReady(tool = 'cursor', opts = {}) {
  const {
    onLog,
    env = process.env,
    project = '',
    task = '',
    runId = '',
    signal,
    skipWait = false,
    captureLoginUrl: captureLoginUrlOpt,
    ...rest
  } = opts;

  if (tool !== 'cursor' && tool !== 'claude') {
    const err = new Error(`assertCliAuthReady: unsupported tool ${tool}`);
    err.code = 'CLI_AUTH_UNSUPPORTED';
    throw err;
  }

  const check = probeFn(tool);
  onLog?.(`[cli-auth] probing ${tool} session…`);
  let result = await check({ env, ...rest });

  if (!result.ok && result.status === 'auth_required') {
    onLog?.(`[cli-auth] first ${tool} probe failed; re-checking once…`);
    result = await check({ env, ...rest });
  }

  if (result.ok) {
    onLog?.(
      `[cli-auth] ok tool=${tool} status=${result.status} (${result.elapsedMs ?? '?'}ms) ${result.reason}`
    );
    return result;
  }

  // Phase B: start LIVE login (do not kill), notify, park, wait.
  let authUrl = result.authUrl || '';
  let authCodeHint = '';

  if (typeof captureLoginUrlOpt === 'function') {
    try {
      const captured = await captureLoginUrlOpt({ env });
      authUrl = captured.authUrl || authUrl;
      authCodeHint = captured.authCode || captured.authCodeFromCli || '';
    } catch (err) {
      onLog?.(`[cli-auth] custom capture failed: ${err.message}`);
    }
  } else if (captureLoginUrlOpt !== false && result.status === 'auth_required') {
    try {
      if (tool === 'cursor') {
        onLog?.(
          '[cli-auth] starting live Cursor login (process stays alive for DeepControl)…'
        );
        const live = await startCursorLoginSession({ env });
        authUrl = live.authUrl || authUrl;
        onLog?.(
          `[cli-auth] login URL: ${authUrl || '(none yet)'} running=${live.running}`
        );
      } else {
        onLog?.('[cli-auth] starting live Claude login (paste browser code next)…');
        const live = await startClaudeLoginSession({ env });
        authUrl = live.authUrl || authUrl;
        authCodeHint = live.authCodeFromCli || '';
        onLog?.(
          `[cli-auth] login URL: ${authUrl || '(none yet)'}` +
            (authCodeHint ? ` cliCode=${authCodeHint}` : '')
        );
      }
    } catch (err) {
      onLog?.(`[cli-auth] live login start failed: ${err.message}`);
    }
  }

  const parked = parkTask(
    {
      tool,
      project,
      task,
      runId,
      authUrl,
      reason: result.reason,
    },
    { env }
  );

  try {
    await notifyCliAuthRequired({
      tool,
      authUrl,
      authCode: authCodeHint,
      reason: result.reason,
      project,
      task,
      runId,
      queueId: parked.id,
      onLog,
      env,
    });
  } catch (err) {
    onLog?.(`[cli-auth] notify failed: ${err.message}`);
  }

  const waitMs = waitMsForTool(tool, env);
  if (skipWait || waitMs <= 0) {
    const err = buildAuthError(tool, result, authUrl, authCodeHint);
    err.queueId = parked.id;
    onLog?.(
      `[cli-auth] FAIL tool=${tool} status=${result.status} reason=${result.reason}` +
        (authUrl ? ` authUrl=${authUrl}` : '')
    );
    throw err;
  }

  onLog?.(
    `[cli-auth] parked queueId=${parked.id}; waiting up to ${waitMs}ms for ${tool} browser login…` +
      (tool === 'cursor'
        ? ' (keep login process alive — do not kill agent login)'
        : ' (send browser code via Telegram /api/cli-auth/submit-code)')
  );

  const recovered = await waitForCliAuth({
    tool,
    onLog,
    env,
    timeoutMs: waitMs,
    signal,
    ...rest,
  });

  if (recovered.ok) {
    removeParked(parked.id);
    return recovered;
  }

  const err = buildAuthError(
    tool,
    {
      ...recovered,
      reason: recovered.reason || result.reason,
    },
    authUrl,
    authCodeHint
  );
  err.code = 'CLI_AUTH_TIMEOUT';
  err.queueId = parked.id;
  onLog?.(
    `[cli-auth] FAIL tool=${tool} status=${err.status} reason=${err.message}` +
      (authUrl ? ` authUrl=${authUrl}` : '')
  );
  throw err;
}

function buildAuthError(tool, result, authUrl, authCode = '') {
  const err = new Error(
    `CLI auth required for ${tool}: ${result.reason}` +
      (authUrl ? ` — open ${authUrl}` : '') +
      (authCode ? ` — code ${authCode}` : '')
  );
  err.code = 'CLI_AUTH_REQUIRED';
  err.tool = tool;
  err.status = result.status;
  err.authUrl = authUrl || result.authUrl || '';
  err.authCode = authCode || '';
  err.detail = result.detail || '';
  err.health = result;
  return err;
}
