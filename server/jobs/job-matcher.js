import {
  DEFAULT_JOB_KEYWORDS,
  extractApplyContacts,
  scoreJobMessage,
} from '../whatsapp-job-scanner.js';

/**
 * CS-graduate / junior software roles (Hebrew + English).
 * Intentionally includes Frontend, QA, data, mobile, DevOps — not only Full Stack.
 */
export const TARGET_ROLE_PATTERNS = [
  /full[\s-]?stack/i,
  /fullstack/i,
  /פול[\s-]?סטאק/i,
  /פולסטאק/i,
  /backend/i,
  /back[\s-]?end/i,
  /בק.?אנד/i,
  /בקאנד/i,
  /front[\s-]?end/i,
  /frontend/i,
  /פרונט[\s-]?אנד/i,
  /פרונטאנד/i,
  /software\s+engineer/i,
  /software\s+developer/i,
  /web\s+developer/i,
  /מפתח(?:ת)?(?:\s|$)/,
  /תוכניתן(?:ית)?/,
  /הנדסת\s*תוכנה/,
  /מדעי\s*המחשב/,
  /מדמ"?ח/,
  /server[\s-]?side/i,
  /node\.?js/i,
  /nestjs/i,
  /react(\s|$)/i,
  /typescript/i,
  /javascript\s+developer/i,
  /python\s+developer/i,
  /\.net\b/i,
  /java\s+(developer|engineer|backend)/i,
  /golang|go developer/i,
  /מפתח.?backend/i,
  /מפתח.?full/i,
  /מפתח.?פול/i,
  /מפתח.?פרונט/i,
  /mobile\s+(developer|engineer)/i,
  /android\s+developer/i,
  /ios\s+developer/i,
  /react\s*native/i,
  /flutter/i,
  /\bqa\b/i,
  /automation\s+engineer/i,
  /בודק(?:ת)?\s*תוכנה/,
  /אוטומציה/,
  /data\s+(analyst|engineer|scientist)/i,
  /אנליסט(?:ית)?\s*נתונים/,
  /מנתח(?:ת)?\s*נתונים/,
  /\bdevops\b/i,
  /\bsre\b/i,
  /platform\s+engineer/i,
  /cyber\s*security/i,
  /security\s+engineer/i,
  /אבטחת\s*מידע/,
  /machine\s+learning/i,
  /\bml\s+engineer/i,
  /\bai\s+engineer/i,
  /embedded\s+software/i,
  /firmware/i,
  /ג['׳']וניור/,
  /\bjunior\b/i,
  /\bintern(ship)?\b/i,
  /סטאז['׳']ר/,
  /סטודנט(?:ית)?\s+(?:למשרה|לפיתוח|לתכנות)/,
];

/** Non-CS disciplines that show up in the same job groups (e.g. Referally). */
export const EXCLUDED_ROLE_PATTERNS = [
  /materials?\s+engineer/i,
  /materials?\s+engineering/i,
  /מהנדס(?:ת)?\s*חומרים/,
  /הנדסת\s*חומרים/,
  /metallurg/i,
  /mechanical\s+engineer/i,
  /מהנדס(?:ת)?\s*מכונות/,
  /הנדסת\s*מכונות/,
  /civil\s+engineer/i,
  /מהנדס(?:ת)?\s*אזרחי/,
  /מהנדס(?:ת)?\s*בניין/,
  /chemical\s+engineer/i,
  /מהנדס(?:ת)?\s*כימ/,
  /הנדסת\s*כימיה/,
  /electrical\s+engineer/i,
  /מהנדס(?:ת)?\s*חשמל/,
  /הנדסת\s*חשמל/,
  /industrial\s+designer/i,
  /אדריכל(?:ית)?/,
];

const DEFAULT_ROLE_NEEDLES = [
  'Full Stack',
  'Backend',
  'Frontend',
  'Software Engineer',
  'מפתח',
  'פול סטאק',
  'בקאנד',
  'פרונט',
  'ג׳וניור',
];

export function isExcludedNonCsRole(body) {
  const text = String(body || '');
  return EXCLUDED_ROLE_PATTERNS.some((re) => re.test(text));
}

/**
 * Detect a CS-graduate / junior software job (HE/EN).
 * Kept export name for callers; scope is no longer Full Stack/Backend only.
 * @param {string} body
 * @param {string[]} [extraRoles]
 * @returns {{ matches: boolean, rolesMatched: string[], score: number, matchedSignals: string[], contacts: object, excluded?: boolean }}
 */
export function matchFullStackOrBackend(body, extraRoles = []) {
  const text = String(body || '');
  if (isExcludedNonCsRole(text)) {
    return {
      matches: false,
      rolesMatched: [],
      score: 0,
      matchedSignals: ['excluded-non-cs'],
      contacts: extractApplyContacts(text),
      excluded: true,
    };
  }

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
    roles: [...new Set([...extraRoles, ...DEFAULT_ROLE_NEEDLES])],
  });

  const contacts = extractApplyContacts(text);
  const uniqueRoles = [...new Set(rolesMatched)];
  const matches = uniqueRoles.length > 0 && scored.isJob;

  return {
    matches,
    rolesMatched: uniqueRoles,
    score: scored.score + uniqueRoles.length * 2,
    matchedSignals: [
      ...new Set([...scored.matchedSignals, ...uniqueRoles.map((r) => `role:${r}`)]),
    ],
    contacts,
  };
}

export const matchCsGraduateJob = matchFullStackOrBackend;

/**
 * Filter messages that look like CS-junior / software jobs.
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
