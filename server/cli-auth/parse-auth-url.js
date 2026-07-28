/**
 * Extract auth URLs and one-time login / device codes from CLI output.
 */

const URL_RE = /https?:\/\/[^\s"'<>)\]}]+/gi;

const AUTH_HINT_RE =
  /authentication required|not logged in|please log in|login required|sign in|authorize|auth\.cursor|claude\.ai\/|cursor\.com\/login|cursor\.com\/auth|paste code here/i;

/**
 * @param {string} text
 * @returns {string[]}
 */
export function extractUrls(text) {
  if (!text) return [];
  const found = String(text).match(URL_RE) || [];
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
 * Extract a one-time login / device code from CLI or user message.
 * Claude (remote/container): browser often shows a code to paste back into the CLI.
 * Some CLIs also print a user-code for the browser.
 *
 * @param {string} text
 * @returns {string}
 */
export function extractAuthCode(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';

  const labeled = raw.match(
    /(?:paste\s+code(?:\s+here)?|login\s+code|verification\s+code|auth(?:entication)?\s+code|user\s*code|device\s*code)\s*[:=]\s*([A-Z0-9]{4}(?:-[A-Z0-9]{4}){1,3}|[A-Z0-9]{6,32})/i
  );
  if (labeled?.[1]) return labeled[1].trim();

  // Standalone device-style codes: ABCD-EFGH
  const standalone = raw.match(/\b([A-Z0-9]{4}(?:-[A-Z0-9]{4}){1,3})\b/i);
  if (standalone?.[1]) return standalone[1].trim();

  // Short paste-only message: entire message is the code
  if (/^[A-Z0-9]{4}(?:-[A-Z0-9]{4}){1,3}$/i.test(raw)) {
    return raw;
  }
  if (/^[A-Z0-9]{6,32}$/i.test(raw) && !/^https?:/i.test(raw)) {
    return raw;
  }

  return '';
}

/**
 * True when a Telegram/chat message is likely only an auth code reply.
 * @param {string} text
 */
export function looksLikeAuthCodeMessage(text) {
  const raw = String(text || '').trim();
  if (!raw || raw.length > 64) return false;
  if (/^\/authcode\b/i.test(raw)) return true;
  if (extractAuthCode(raw) && !/\s{2,}|\n/.test(raw) && raw.split(/\s+/).length <= 3) {
    // Avoid treating normal short Hebrew/English replies as codes
    if (/[א-ת]/.test(raw) && !/^[A-Z0-9-]+$/i.test(raw)) return false;
    if (/^(yes|no|ok|כן|לא|מאשר|בטל)\b/i.test(raw)) return false;
    return Boolean(extractAuthCode(raw));
  }
  return false;
}

/**
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeAuthFailure(text) {
  return AUTH_HINT_RE.test(String(text || ''));
}
