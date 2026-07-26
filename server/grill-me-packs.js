/**
 * Domain Grill-Me packs: structured clarifying questions for perfect specs
 * before any coding dispatch. WhatsApp jobs + CV submission is the first pack.
 */

export const PACK_WHATSAPP_JOBS_CV = 'whatsapp-jobs-cv';

/** @typedef {{ id: string, he: string, en: string }} GrillMeQuestion */
/** @typedef {{ id: string, titleHe: string, titleEn: string, questions: GrillMeQuestion[] }} GrillMeCategory */

/** @type {{ id: string, titleHe: string, titleEn: string, summaryHe: string, summaryEn: string, categories: GrillMeCategory[] }} */
export const WHATSAPP_JOBS_CV_PACK = {
  id: PACK_WHATSAPP_JOBS_CV,
  titleHe: 'סריקת משרות ב-WhatsApp והגשת קורות חיים',
  titleEn: 'WhatsApp job scanning and CV submission',
  summaryHe:
    'כלי לסוכן שיסרוק קבוצות WhatsApp למשרות רלוונטיות ויגיש קורות חיים — לפני מימוש נדייק אפיון מלא.',
  summaryEn:
    'An agent tool that scans WhatsApp groups for relevant jobs and submits CVs — refine a full spec before any implementation.',
  categories: [
    {
      id: 'scope-goals',
      titleHe: 'היקף ומטרות',
      titleEn: 'Scope and goals',
      questions: [
        {
          id: 'primary-goal',
          he: 'מה המטרה העיקרית: התראות בלבד, הגשות אוטומטיות, או שילוב (סריקה + הצעה + אישור + הגשה)?',
          en: 'Primary goal: alerts only, auto-apply, or hybrid (scan → propose → approve → submit)?',
        },
        {
          id: 'success-metric',
          he: 'איך נמדוד הצלחה בשבוע הראשון (מספר משרות שזוהו, הגשות, ראיונות, חיסכון בזמן)?',
          en: 'How will we measure success in week one (jobs found, submissions, interviews, time saved)?',
        },
        {
          id: 'out-of-scope',
          he: 'מה במפורש מחוץ להיקף בגרסה הראשונה (לינקדאין, מייל, אתרי דרושים, בוטים אחרים)?',
          en: 'What is explicitly out of scope for v1 (LinkedIn, email, job boards, other bots)?',
        },
      ],
    },
    {
      id: 'whatsapp-access',
      titleHe: 'גישה ל-WhatsApp וקבוצות',
      titleEn: 'WhatsApp access and groups',
      questions: [
        {
          id: 'wa-client',
          he: 'איך מתחברים ל-WhatsApp: WhatsApp Web / Baileys / API עסקי / ייצוא צ׳אט ידני / אחר?',
          en: 'How do we connect to WhatsApp: WhatsApp Web / Baileys / Business API / manual chat export / other?',
        },
        {
          id: 'target-groups',
          he: 'אילו קבוצות לסרוק (רשימה קבועה, תגיות, כל הקבוצות, רק כאלה עם מילות מפתח בשם)?',
          en: 'Which groups to scan (fixed list, tags, all groups, name-keyword filter only)?',
        },
        {
          id: 'scan-cadence',
          he: 'מה קצב הסריקה (בזמן אמת, כל X דקות, פעם ביום) ומה חלון ההיסטוריה לסריקה ראשונה?',
          en: 'Scan cadence (realtime, every X minutes, daily) and history window for the first backfill?',
        },
        {
          id: 'media-handling',
          he: 'האם לנתח גם תמונות/PDF/הודעות קוליות של משרות, או טקסט בלבד ב-v1?',
          en: 'Should v1 parse images/PDFs/voice notes for jobs, or text only?',
        },
      ],
    },
    {
      id: 'job-matching',
      titleHe: 'זיהוי והתאמת משרות',
      titleEn: 'Job detection and matching',
      questions: [
        {
          id: 'match-signals',
          he: 'מה מסמן "משרה" (מילות מפתח בעברית/אנגלית, תבניות כמו "דרוש/ה", לינקים, מספרי טלפון)?',
          en: 'What signals mean "job post" (HE/EN keywords, patterns like "hiring", links, phone numbers)?',
        },
        {
          id: 'relevance-filter',
          he: 'איך מסננים רלוונטיות לפרופיל (תפקידים, סטאק, מיקום, היברידי/משרד, ותק, שכר מינימום)?',
          en: 'How do we filter relevance (roles, stack, location, hybrid/onsite, seniority, min salary)?',
        },
        {
          id: 'dedupe',
          he: 'איך מטפלים בכפילויות בין קבוצות ובמשרות שחוזרות עם ניסוח שונה?',
          en: 'How should we dedupe across groups and reworded reposts?',
        },
        {
          id: 'languages',
          he: 'באילו שפות המשרות והסוכן צריכים לעבוד (עברית, אנגלית, שתיהן)?',
          en: 'Which languages for job text and agent replies (Hebrew, English, both)?',
        },
      ],
    },
    {
      id: 'candidate-profile',
      titleHe: 'מבנה פרופיל מועמד',
      titleEn: 'Candidate profile structure',
      questions: [
        {
          id: 'profile-fields',
          he: 'אילו שדות חובה בפרופיל (שם, תפקיד יעד, skills, שנות ניסיון, מיקום, זמינות, לינקים)?',
          en: 'Which profile fields are required (name, target role, skills, years, location, availability, links)?',
        },
        {
          id: 'cv-assets',
          he: 'איפה נמצאים קבצי ה-CV (נתיב מקומי, כמה גרסאות לפי תפקיד/שפה, תבנית מכתב מקדים)?',
          en: 'Where do CV files live (local path, role/language variants, cover-letter template)?',
        },
        {
          id: 'constraints',
          he: 'מהם אילוצי סינון קשיחים (לא סטארטאפים, לא גיוס ביטחוני, לא שליחויות, ימי שלישי בלבד וכו׳)?',
          en: 'Hard exclusion constraints (no startups, no security clearance roles, no courier jobs, Tue-only, etc.)?',
        },
        {
          id: 'personalization',
          he: 'האם להתאים אוטומטית מכתב מקדים / תקציר לכל משרה, או לשלוח CV קבוע?',
          en: 'Auto-personalize cover note per job, or always send a fixed CV pack?',
        },
      ],
    },
    {
      id: 'submission-flow',
      titleHe: 'זרימת הגשה',
      titleEn: 'Submission flow',
      questions: [
        {
          id: 'submit-channel',
          he: 'לאן מגישים: תשובה באותה קבוצה, DM למפרסם, אימייל שחולץ מההודעה, טופס חיצוני, או הכל לפי זיהוי?',
          en: 'Submit where: reply in group, DM poster, email parsed from message, external form, or detect per post?',
        },
        {
          id: 'message-template',
          he: 'מה תבנית הודעת ההגשה (טון, אורך, שפה, האם לצרף קובץ או לינק בלבד)?',
          en: 'What is the apply-message template (tone, length, language, attach file vs link only)?',
        },
        {
          id: 'rate-limits',
          he: 'מה מגבלות קצב בטוחות (הגשות ליום, השהייה בין הודעות) כדי לא להיחסם?',
          en: 'Safe rate limits (applies/day, delay between messages) to avoid bans?',
        },
        {
          id: 'failure-handling',
          he: 'מה קורה כשאין אימייל/מספר, כשההגשה נכשלת, או כשהמשרה כבר נסגרה?',
          en: 'What if no email/phone, submit fails, or the role looks closed?',
        },
      ],
    },
    {
      id: 'approval-workflow',
      titleHe: 'אישורי אדם ו"סיום"',
      titleEn: 'Human approval and done criteria',
      questions: [
        {
          id: 'who-approves',
          he: 'מי מאשר הגשה: אתה בטלפון/טרמינל לכל משרה, אישור לפי כללים, או אוטומטי מעל ציון התאמה?',
          en: 'Who approves applies: you per job (phone/terminal), rule-based, or auto above a match score?',
        },
        {
          id: 'approval-ux',
          he: 'איך נראה אישור (כפתור ב-PWA, תשובת כן/לא בקול, פקודה ב-chat, digest יומי)?',
          en: 'Approval UX (PWA button, voice yes/no, chat command, daily digest)?',
        },
        {
          id: 'done-means',
          he: 'מתי משימת "הגשה" נחשבת הושלמה (נשלח, נקרא, קיבלנו תשובה, נקבע ראיון)?',
          en: 'When is an apply "done" (sent, read, reply received, interview booked)?',
        },
        {
          id: 'audit-log',
          he: 'איזה לוג/היסטוריה חובה לשמור (משרה מקור, ציון, מה נשלח, מתי, סטטוס)?',
          en: 'What audit trail is required (source post, score, payload sent, time, status)?',
        },
      ],
    },
    {
      id: 'acceptance-privacy',
      titleHe: 'קריטריוני קבלה, פרטיות ובטיחות',
      titleEn: 'Acceptance criteria, privacy, and safety',
      questions: [
        {
          id: 'acceptance-v1',
          he: 'מהם 3–5 קריטריוני קבלה ל-v1 שנוכל לבדוק ב-E2E או ידנית?',
          en: 'What are 3–5 v1 acceptance criteria we can verify via E2E or manually?',
        },
        {
          id: 'privacy',
          he: 'איפה מותר לאחסן הודעות קבוצה ו-CV (לוקאלי בלבד / הצפנה / מחיקה אחרי X ימים)?',
          en: 'Where may group messages and CVs be stored (local-only / encryption / delete after X days)?',
        },
        {
          id: 'safety',
          he: 'מה אסור לסוכן לעשות לעולם (שליחה לקבוצה בלי אישור, שיתוף CV מחוץ לרשימה, מענה לספאם)?',
          en: 'What must the agent never do (post to group without approval, share CV off-allowlist, reply to spam)?',
        },
        {
          id: 'stack-constraints',
          he: 'האם הכלי חייב להיות MCP tool מקומי בסוכן הזה בלבד, או שירות נפרד?',
          en: 'Must this be a local MCP tool inside this agent only, or a separate service?',
        },
      ],
    },
  ],
};

const PACKS = Object.freeze({
  [PACK_WHATSAPP_JOBS_CV]: WHATSAPP_JOBS_CV_PACK,
});

export function listGrillMePacks() {
  return Object.values(PACKS).map((p) => ({
    id: p.id,
    titleHe: p.titleHe,
    titleEn: p.titleEn,
  }));
}

export function getGrillMePack(packId) {
  return PACKS[packId] || null;
}

/**
 * Detect WhatsApp jobs / CV Grill-Me discovery requests (HE + EN).
 */
export function isWhatsAppJobsGrillMeRequest(text) {
  const t = String(text || '');
  if (!t.trim()) return false;

  const mentionsWhatsApp = /whats?\s*app|וואטסאפ|ווטסאפ/i.test(t);
  const mentionsJobs = /משרות|דרושים|jobs?|hiring|recruit/i.test(t);
  const mentionsCv =
    /קורות\s*חיים|קו.?ח\.?|CV|resume|curriculum\s+vitae|הגשת|apply|application/i.test(
      t
    );
  const asksGrillMe =
    /grill-?me|גריל|תשאל|שאלות|אפיון|clarif|spec(ification)?/i.test(t);

  if (mentionsWhatsApp && (mentionsJobs || mentionsCv)) return true;
  if (asksGrillMe && mentionsWhatsApp && mentionsJobs) return true;
  if (asksGrillMe && mentionsJobs && mentionsCv) return true;
  return false;
}

export function detectGrillMePack(text) {
  if (isWhatsAppJobsGrillMeRequest(text)) return PACK_WHATSAPP_JOBS_CV;
  return null;
}

function pickLocale(locale) {
  return locale === 'en' ? 'en' : 'he';
}

/**
 * Full questionnaire for a perfect spec (all categories).
 * Grill-Me chat still prefers few questions per turn; this is the complete bank.
 */
export function getAllQuestions(packId) {
  const pack = getGrillMePack(packId);
  if (!pack) return [];
  return pack.categories.flatMap((cat) =>
    cat.questions.map((q) => ({
      ...q,
      categoryId: cat.id,
      categoryHe: cat.titleHe,
      categoryEn: cat.titleEn,
    }))
  );
}

/**
 * First Grill-Me turn: a few sharp questions across mandatory themes.
 */
export function getOpeningQuestions(packId, { limit = 5 } = {}) {
  const pack = getGrillMePack(packId);
  if (!pack) return [];
  const preferred = [
    'primary-goal',
    'wa-client',
    'relevance-filter',
    'profile-fields',
    'who-approves',
  ];
  const all = getAllQuestions(packId);
  const byId = new Map(all.map((q) => [q.id, q]));
  const picked = [];
  for (const id of preferred) {
    if (byId.has(id)) picked.push(byId.get(id));
  }
  for (const q of all) {
    if (picked.length >= limit) break;
    if (!picked.some((p) => p.id === q.id)) picked.push(q);
  }
  return picked.slice(0, limit);
}

/**
 * Format a Grill-Me reply (Hebrew by default) with opening questions + full bank note.
 */
export function formatGrillMeReply(packId, { locale = 'he', openingLimit = 5 } = {}) {
  const pack = getGrillMePack(packId);
  if (!pack) return '';
  const loc = pickLocale(locale);
  const title = loc === 'he' ? pack.titleHe : pack.titleEn;
  const summary = loc === 'he' ? pack.summaryHe : pack.summaryEn;
  const opening = getOpeningQuestions(packId, { limit: openingLimit });
  const all = getAllQuestions(packId);

  const lines = [];
  if (loc === 'he') {
    lines.push(`Grill-Me Mode פעיל עבור: ${title}`);
    lines.push(summary);
    lines.push('');
    lines.push('נתחיל עם השאלות החדות ביותר (ענה נקודתית; נמשיך משם):');
    opening.forEach((q, i) => {
      lines.push(`${i + 1}. [${q.categoryHe}] ${q.he}`);
    });
    lines.push('');
    lines.push(
      `יש עוד ${all.length - opening.length} שאלות באפיון המלא (גישה ל-WhatsApp, התאמה, פרופיל, הגשה, אישורים, פרטיות).`
    );
    lines.push(
      'אחרי שנמלא את האפיון — אכין פרומפט מימוש סופי ותאשר עם "שגר ל-Cursor" / skip Grill-Me Mode and dispatch.'
    );
    lines.push('');
    lines.push('--- אפיון מלא (כל השאלות) ---');
    for (const cat of pack.categories) {
      lines.push('');
      lines.push(`## ${cat.titleHe}`);
      cat.questions.forEach((q, i) => {
        lines.push(`${i + 1}. ${q.he}`);
      });
    }
  } else {
    lines.push(`Grill-Me Mode is ON for: ${title}`);
    lines.push(summary);
    lines.push('');
    lines.push('Starting with the sharpest questions (answer briefly; we continue from there):');
    opening.forEach((q, i) => {
      lines.push(`${i + 1}. [${q.categoryEn}] ${q.en}`);
    });
    lines.push('');
    lines.push(
      `${all.length - opening.length} more questions remain in the full spec bank (access, matching, profile, submit, approval, privacy).`
    );
    lines.push(
      'Once the spec is complete I will draft a final implementation prompt; confirm with "skip Grill-Me Mode and dispatch" / "שגר ל-Cursor".'
    );
    lines.push('');
    lines.push('--- Full specification questionnaire ---');
    for (const cat of pack.categories) {
      lines.push('');
      lines.push(`## ${cat.titleEn}`);
      cat.questions.forEach((q, i) => {
        lines.push(`${i + 1}. ${q.en}`);
      });
    }
  }

  return lines.join('\n');
}

/**
 * Empty markdown אפיון scaffold with unanswered slots.
 */
export function buildSpecMarkdown(packId, { locale = 'he' } = {}) {
  const pack = getGrillMePack(packId);
  if (!pack) return '';
  const loc = pickLocale(locale);
  const title = loc === 'he' ? pack.titleHe : pack.titleEn;
  const lines = [
    `# ${title} — Grill-Me Spec`,
    '',
    loc === 'he'
      ? '_סטטוס: ממתין לתשובות. אין לשגר ל-Cursor עד שהאפיון מאושר._'
      : '_Status: awaiting answers. Do not dispatch to Cursor until the spec is confirmed._',
    '',
  ];

  for (const cat of pack.categories) {
    lines.push(`## ${loc === 'he' ? cat.titleHe : cat.titleEn}`);
    lines.push('');
    for (const q of cat.questions) {
      lines.push(`### ${q.id}`);
      lines.push(`**Q:** ${loc === 'he' ? q.he : q.en}`);
      lines.push('**A:** _TBD_');
      lines.push('');
    }
  }

  lines.push('## Dispatch gate');
  lines.push('');
  lines.push(
    loc === 'he'
      ? 'כשהתשובות מלאות: צור פרומפט מימוש ואשר עם `שגר ל-Cursor` / `skip Grill-Me Mode and dispatch`.'
      : 'When answers are complete: draft the implementation prompt and confirm with `skip Grill-Me Mode and dispatch` / `שגר ל-Cursor`.'
  );
  lines.push('');
  return lines.join('\n');
}
