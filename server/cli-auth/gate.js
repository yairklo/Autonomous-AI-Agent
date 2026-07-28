/**
 * Pre-dispatch / pre-chat CLI auth gate + Phase B notify / wait / resume.
 * Supports Cursor (coding) and Claude (chat / Grill-Me).
 */

import { checkClaudeAuth, checkCursorAuth } from './health.js';
import {
  captureClaudeLoginUrl,
  captureCursorLoginUrl,
} from './capture-login-url.js';
import { notifyCliAuthRequired } from './notify.js';
import { parkTask, removeParked } from './queue.js';

export const DEFAULT_AUTH_WAIT_MS = 1_800_000; // 30 min
export const DEFAULT_AUTH_POLL_MS = 8_000;

function probeFn(tool) {
  return tool === 'claude' ? checkClaudeAuth : checkCursorAuth;
}

function defaultCaptureFn(tool) {
  return tool === 'claude' ? captureClaudeLoginUrl : captureCursorLoginUrl;
}

function waitMsForTool(tool, env) {
  if (tool === 'claude') {
    // Chat/Telegram: default fail-fast so the auth URL can be returned in-band.
    // Set CLI_AUTH_CLAUDE_WAIT_MS to poll/resume without a second user message.
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
 * @param {object} [opts]
 * @param {'cursor'|'claude'} [opts.tool]
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
      `[cli-auth] waiting for ${tool} login… attempt=${attempt} status=${result.status}`
    );
    await new Promise((r) => setTimeout(r, Math.max(1000, intervalMs)));
  }
}

/**
 * @param {'cursor'|'claude'} [tool]
 * @param {object} [opts]
 * @returns {Promise<import('./health.js').CliAuthHealthResult>}
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

  // One immediate re-probe (Phase A light): handles race after volume mount.
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

  // Phase B: capture URL (if missing), notify human, park, wait for recovery.
  let authUrl = result.authUrl || '';
  const captureFn =
    typeof captureLoginUrlOpt === 'function'
      ? captureLoginUrlOpt
      : captureLoginUrlOpt === false
        ? null
        : defaultCaptureFn(tool);

  if (!authUrl && result.status === 'auth_required' && captureFn) {
    try {
      onLog?.(`[cli-auth] capturing ${tool} login URL…`);
      const captured = await captureFn({ env });
      authUrl = captured.authUrl || '';
      if (authUrl) onLog?.(`[cli-auth] login URL: ${authUrl}`);
    } catch (err) {
      onLog?.(`[cli-auth] login URL capture failed: ${err.message}`);
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
    const err = buildAuthError(tool, result, authUrl);
    err.queueId = parked.id;
    onLog?.(
      `[cli-auth] FAIL tool=${tool} status=${result.status} reason=${result.reason}` +
        (authUrl ? ` authUrl=${authUrl}` : '')
    );
    throw err;
  }

  onLog?.(
    `[cli-auth] parked queueId=${parked.id}; waiting up to ${waitMs}ms for ${tool} browser login…`
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
    authUrl
  );
  err.code = 'CLI_AUTH_TIMEOUT';
  err.queueId = parked.id;
  onLog?.(
    `[cli-auth] FAIL tool=${tool} status=${err.status} reason=${err.message}` +
      (authUrl ? ` authUrl=${authUrl}` : '')
  );
  throw err;
}

function buildAuthError(tool, result, authUrl) {
  const err = new Error(
    `CLI auth required for ${tool}: ${result.reason}` +
      (authUrl ? ` — open ${authUrl}` : '')
  );
  err.code = 'CLI_AUTH_REQUIRED';
  err.tool = tool;
  err.status = result.status;
  err.authUrl = authUrl || result.authUrl || '';
  err.detail = result.detail || '';
  err.health = result;
  return err;
}
