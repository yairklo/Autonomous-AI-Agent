/**
 * Shared Cursor Agent CLI environment for dispatch + auth health probes.
 * Keeps HOME aligned with Coolify volumes (/root/.cursor).
 */

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {NodeJS.ProcessEnv}
 */
export function buildCursorAgentEnv(env = process.env) {
  // Coolify / Docker: interactive `docker exec` shells often have HOME=/root
  // (where `agent login` stores creds in the cursor_config volume), but the
  // Node server process may inherit a different/empty HOME. Cursor then looks
  // in the wrong place and reports "Authentication required".
  const home =
    String(env.HOME || env.USERPROFILE || '').trim() ||
    (process.platform === 'win32'
      ? env.USERPROFILE || process.env.USERPROFILE || ''
      : '/root');

  return {
    ...env,
    HOME: home,
    ...(process.platform === 'win32' && home ? { USERPROFILE: home } : {}),
    DISPATCH_NO_CLAUDE: '1',
    CI: env.CI || '1',
    NO_OPEN_BROWSER: env.NO_OPEN_BROWSER || '1',
    IS_SANDBOX: env.IS_SANDBOX || '1',
  };
}
