/**
 * Pre-dispatch CLI auth gate. Fail fast with CLI_AUTH_REQUIRED — never hang.
 */

import { checkCursorAuth } from './health.js';

/**
 * @param {'cursor'} [tool]
 * @param {object} [opts]
 * @param {(line: string) => void} [opts.onLog]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @returns {Promise<import('./health.js').CliAuthHealthResult>}
 */
export async function assertCliAuthReady(tool = 'cursor', opts = {}) {
  const { onLog, env = process.env, ...rest } = opts;

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

  const err = new Error(
    `CLI auth required for cursor: ${result.reason}` +
      (result.authUrl ? ` — open ${result.authUrl}` : '')
  );
  err.code = 'CLI_AUTH_REQUIRED';
  err.tool = 'cursor';
  err.status = result.status;
  err.authUrl = result.authUrl || '';
  err.detail = result.detail || '';
  err.health = result;
  onLog?.(
    `[cli-auth] FAIL status=${result.status} reason=${result.reason}` +
      (result.authUrl ? ` authUrl=${result.authUrl}` : '')
  );
  throw err;
}
