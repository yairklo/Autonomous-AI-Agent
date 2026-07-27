/**
 * Resolve the voice-agent HTTP base URL for cross-service bridges.
 *
 * Coolify: set VOICE_AGENT_URL (or JOINUP_RUN_LOG_URL) to the public/private
 * URL of the voice-agent application — never hardcode Compose service names.
 *
 * Local optional compose: VOICE_AGENT_URL=http://app:8787 is fine because it
 * is still an explicit env var, not an implicit network alias dependency.
 *
 * Precedence:
 *   1. VOICE_AGENT_URL
 *   2. JOINUP_RUN_LOG_URL (legacy alias)
 *   3. http://{JOINUP_RUN_LOG_HOST|127.0.0.1}:{VOICE_AGENT_PORT|PORT|8787}
 */
export function resolveVoiceAgentBaseUrl(envSource = process.env) {
  const explicit =
    String(envSource.VOICE_AGENT_URL || '').trim() ||
    String(envSource.JOINUP_RUN_LOG_URL || '').trim();
  if (explicit) return explicit.replace(/\/$/, '');

  const host = String(envSource.JOINUP_RUN_LOG_HOST || '127.0.0.1').trim() || '127.0.0.1';
  const port =
    String(envSource.VOICE_AGENT_PORT || envSource.PORT || '8787').trim() || '8787';
  return `http://${host}:${port}`;
}
