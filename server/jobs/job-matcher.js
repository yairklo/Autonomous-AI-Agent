import {
  DEFAULT_JOB_KEYWORDS,
  extractApplyContacts,
  scoreJobMessage,
} from '../whatsapp-job-scanner.js';

/** Full Stack / Backend signals (Hebrew + English). */
export const TARGET_ROLE_PATTERNS = [
  /full[\s-]?stack/i,
  /fullstack/i,
  /פול[\s-]?סטאק/i,
  /פולסטאק/i,
  /full stack developer/i,
  /backend/i,
  /back[\s-]?end/i,
  /בק.?אנד/i,
  /בקאנד/i,
  /server[\s-]?side/i,
  /node\.?js/i,
  /nestjs/i,
  /\.net\b/i,
  /java backend/i,
  /golang|go developer/i,
  /מפתח.?backend/i,
  /מפתח.?full/i,
  /מפתח.?פול/i,
];

/**
 * Detect whether a job targets Full Stack / Backend (HE/EN).
 * @param {string} body
 * @param {string[]} [extraRoles]
 * @returns {{ matches: boolean, rolesMatched: string[], score: number, matchedSignals: string[], contacts: object }}
 */
export function matchFullStackOrBackend(body, extraRoles = []) {
  const text = String(body || '');
  const rolesMatched = [];

  for (const re of TARGET_ROLE_PATTERNS) {
    const m = text.match(re);
    if (m) rolesMatched.push(m[0]);
  }

  for (const role of extraRoles) {
    const needle = String(role || '').trim();
    if (!needle) continue;
    if (text.toLowerCase().includes(needle.toLowerCase()) || text.includes(needle)) {
      rolesMatched.push(needle);
    }
  }

  const scored = scoreJobMessage(text, {
    keywords: DEFAULT_JOB_KEYWORDS,
    roles: [...new Set([...extraRoles, 'Full Stack', 'Backend', 'פול סטאק', 'בקאנד'])],
  });

  const contacts = extractApplyContacts(text);
  const uniqueRoles = [...new Set(rolesMatched)];
  const matches =
    uniqueRoles.length > 0 && scored.isJob;

  return {
    matches,
    rolesMatched: uniqueRoles,
    score: scored.score + uniqueRoles.length * 2,
    matchedSignals: [...new Set([...scored.matchedSignals, ...uniqueRoles.map((r) => `role:${r}`)])],
    contacts,
  };
}

/**
 * Filter + enrich messages that look like Full Stack / Backend jobs.
 */
export function filterTargetJobs(messages, { roles = [] } = {}) {
  const out = [];
  for (const msg of messages) {
    const matched = matchFullStackOrBackend(msg.body || msg.text, roles);
    if (!matched.matches) continue;
    out.push({
      ...msg,
      text: (msg.body || msg.text || '').trim(),
      score: matched.score,
      matchedSignals: matched.matchedSignals,
      rolesMatched: matched.rolesMatched,
      contacts: matched.contacts,
      formUrl: matched.contacts.urls?.[0] || null,
    });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}
