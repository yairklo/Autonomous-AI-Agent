/**
 * Pre-dispatch CLI auth gate + Phase B notify / wait / resume.
 */

import { checkCursorAuth } from './health.js';
import { captureCursorLoginUrl } from './capture-login-url.js';
import { notifyCliAuthRequired } from './notify.js';
import { parkTask, removeParked } from './queue.js';

export const DEFAULT_AUTH_WAIT_MS = 1_800_000; // 30 min
export const DEFAULT_AUTH_POLL_MS = 8_000;

/**
 * Poll until Cursor auth is healthy or timeout.
 * @param {object} [opts]
 * @returns {Promise<import('./health.js').CliAuthHealthResult>}
 */
export async function waitForCliAuth({
  onLog,
  env = process.env,
  timeoutMs = Number(env.CLI_AUTH_WAIT_MS || DEFAULT_AUTH_WAIT_MS),
  intervalMs = Number(env.CLI_AUTH_POLL_MS || DEFAULT_AUTH_POLL_MS),
  signal,
  ...rest
} = {}) {
  const started = Date.now();
  let attempt = 0;
  while (true) {
    if (signal?.aborted) {
      const err = new Error('CLI auth wait aborted');
      err.code = 'CLI_AUTH_ABORTED';
      throw err;
    }
    attempt += 1;
    const result = await checkCursorAuth({ env, ...rest });
    if (result.ok) {
      onLog?.(
        `[cli-auth] recovered after ${attempt} poll(s) (${Date.now() - started}ms)`
      );
      return result;
    }
    if (timeoutMs <= 0 || Date.now() - started >= timeoutMs) {
      return {
        ...result,
        ok: false,
        reason: `Timed out waiting for CLI auth (${timeoutMs}ms): ${result.reason}`,
      };
    }
    onLog?.(
      `[cli-auth] waiting for login… attempt=${attempt} status=${result.status}`
    );
    await new Promise((r) => setTimeout(r, Math.max(1000, intervalMs)));
  }
}

/**
 * @param {'cursor'} [tool]
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

  if (tool !== 'cursor') {
    const err = new Error(`assertCliAuthReady: unsupported tool ${tool}`);
    err.code = 'CLI_AUTH_UNSUPPORTED';
    throw err;
  }

  onLog?.('[cli-auth] probing Cursor session…');
  let result = await checkCursorAuth({ env, ...rest });

  // One immediate re-probe (Phase A light): handles race after volume mount.
  if (!result.ok && result.status === 'auth_required') {
    onLog?.('[cli-auth] first probe failed; re-checking once…');
    result = await checkCursorAuth({ env, ...rest });
  }

  if (result.ok) {
    onLog?.(
      `[cli-auth] ok tool=cursor status=${result.status} (${result.elapsedMs ?? '?'}ms) ${result.reason}`
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
        : captureCursorLoginUrl;

  if (!authUrl && result.status === 'auth_required' && captureFn) {
    try {
      onLog?.('[cli-auth] capturing login URL via agent login…');
      const captured = await captureFn({ env });
      authUrl = captured.authUrl || '';
      if (authUrl) onLog?.(`[cli-auth] login URL: ${authUrl}`);
    } catch (err) {
      onLog?.(`[cli-auth] login URL capture failed: ${err.message}`);
    }
  }

  const parked = parkTask(
    {
      tool: 'cursor',
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
      tool: 'cursor',
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

  const waitMs = Number(env.CLI_AUTH_WAIT_MS || DEFAULT_AUTH_WAIT_MS);
  if (skipWait || waitMs <= 0) {
    const err = buildAuthError(result, authUrl);
    err.queueId = parked.id;
    onLog?.(
      `[cli-auth] FAIL status=${result.status} reason=${result.reason}` +
        (authUrl ? ` authUrl=${authUrl}` : '')
    );
    throw err;
  }

  onLog?.(
    `[cli-auth] parked queueId=${parked.id}; waiting up to ${waitMs}ms for browser login…`
  );

  const recovered = await waitForCliAuth({
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
    {
      ...recovered,
      reason: recovered.reason || result.reason,
    },
    authUrl
  );
  err.code = 'CLI_AUTH_TIMEOUT';
  err.queueId = parked.id;
  onLog?.(
    `[cli-auth] FAIL status=${err.status} reason=${err.message}` +
      (authUrl ? ` authUrl=${authUrl}` : '')
  );
  throw err;
}

function buildAuthError(result, authUrl) {
  const err = new Error(
    `CLI auth required for cursor: ${result.reason}` +
      (authUrl ? ` — open ${authUrl}` : '')
  );
  err.code = 'CLI_AUTH_REQUIRED';
  err.tool = 'cursor';
  err.status = result.status;
  err.authUrl = authUrl || result.authUrl || '';
  err.detail = result.detail || '';
  err.health = result;
  return err;
}
