/**
 * Extract browser login / magic-link URLs from CLI stdout/stderr.
 */

const URL_RE = /https?:\/\/[^\s"'<>)\]}]+/gi;

const AUTH_HINT_RE =
  /authentication required|not logged in|please log in|login required|sign in|authorize|auth\.cursor|claude\.ai\/|cursor\.com\/login|cursor\.com\/auth/i;

/**
 * @param {string} text
 * @returns {string[]}
 */
export function extractUrls(text) {
  if (!text) return [];
  const found = String(text).match(URL_RE) || [];
  // Strip trailing punctuation commonly left by log lines.
  return [...new Set(found.map((u) => u.replace(/[.,;:]+$/g, '')))];
}

/**
 * Prefer auth-looking URLs; fall back to first https URL.
 * @param {string} text
 * @returns {string}
 */
export function extractAuthUrl(text) {
  const urls = extractUrls(text);
  if (!urls.length) return '';
  const preferred = urls.find((u) =>
    /login|auth|oauth|device|cli|cursor\.com|anthropic|claude\.ai/i.test(u)
  );
  return preferred || urls[0];
}

/**
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeAuthFailure(text) {
  return AUTH_HINT_RE.test(String(text || ''));
}
