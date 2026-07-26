import fs from 'node:fs';
import path from 'node:path';

/**
 * Local WhatsApp group job scanner (v1).
 * Reads exported WhatsApp chat .txt files (Export chat) — no live WA client.
 */

export const DEFAULT_JOB_KEYWORDS = [
  // Hebrew
  'דרוש',
  'דרושה',
  'דרושים',
  'דרושות',
  'משרה',
  'משרות',
  'מחפשים',
  'מחפשות',
  'מחפש/ת',
  'מחפש',
  'מחפשת',
  'גיוס',
  'מגייסים',
  'מגייסות',
  'הייטק',
  'למשרת',
  'משרת',
  'משרה פנויה',
  'משרה חדשה',
  'דרוש/ה',
  // English
  'hiring',
  "we're hiring",
  'we are hiring',
  'looking for',
  'job opening',
  'job opportunity',
  'open role',
  'open position',
  'position available',
  'seeking',
  'recruiter',
  'apply now',
  'cv / resume',
  'send cv',
  'send resume',
  'full-time',
  'full time',
  'part-time',
  'hybrid role',
];

/** WhatsApp export line patterns (multi-line messages continue without a new stamp). */
const LINE_PATTERNS = [
  // [DD/MM/YYYY, HH:MM:SS] Name: text
  /^\[(\d{1,2}\/\d{1,2}\/\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?)\]\s*([^:]+):\s*(.*)$/i,
  // DD/MM/YYYY, HH:MM - Name: text  OR  M/D/YY, H:MM AM - Name: text
  /^(\d{1,2}\/\d{1,2}\/\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?)\s+-\s+([^:]+):\s*(.*)$/i,
];

/**
 * Parse a WhatsApp chat export into message objects.
 * @param {string} text
 * @param {{ groupName?: string }} [opts]
 * @returns {{ timestamp: string|null, author: string, body: string, groupName: string }[]}
 */
export function parseWhatsappExport(text, { groupName = 'unknown' } = {}) {
  const lines = String(text || '').split(/\r?\n/);
  const messages = [];
  let current = null;

  for (const raw of lines) {
    const line = raw.replace(/^\u200e|\u200f/g, '');
    let matched = null;
    for (const re of LINE_PATTERNS) {
      const m = line.match(re);
      if (m) {
        matched = m;
        break;
      }
    }

    if (matched) {
      if (current) messages.push(current);
      const [, datePart, timePart, author, body] = matched;
      current = {
        timestamp: normalizeTimestamp(datePart, timePart),
        author: String(author || '').trim(),
        body: String(body || ''),
        groupName,
      };
    } else if (current) {
      current.body += `\n${line}`;
    }
  }
  if (current) messages.push(current);
  return messages;
}

function normalizeTimestamp(datePart, timePart) {
  const raw = `${datePart} ${timePart}`.trim();
  const parts = datePart.split(/[/\-.]/).map((p) => Number(p));
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return raw;

  let [a, b, y] = parts;
  // Prefer DD/MM/YYYY when day > 12; otherwise assume DD/MM for Israeli exports.
  let day = a;
  let month = b;
  if (a <= 12 && b > 12) {
    month = a;
    day = b;
  }
  if (y < 100) y += 2000;

  const time = String(timePart).trim();
  const ampm = time.match(/([AP]M)$/i)?.[1];
  const timeCore = time.replace(/\s*[AP]M$/i, '');
  const [hhRaw, mm = '0', ss = '0'] = timeCore.split(':');
  let hh = Number(hhRaw);
  if (ampm) {
    const up = ampm.toUpperCase();
    if (up === 'PM' && hh < 12) hh += 12;
    if (up === 'AM' && hh === 12) hh = 0;
  }

  const iso = new Date(Date.UTC(y, month - 1, day, hh, Number(mm), Number(ss)));
  if (Number.isNaN(iso.getTime())) return raw;
  return iso.toISOString();
}

/**
 * Score a message as a job post.
 * @returns {{ isJob: boolean, score: number, matchedSignals: string[] }}
 */
export function scoreJobMessage(body, { keywords = DEFAULT_JOB_KEYWORDS, roles = [] } = {}) {
  const text = String(body || '');
  const lower = text.toLowerCase();
  const matchedSignals = [];
  let score = 0;

  for (const kw of keywords) {
    const needle = String(kw || '').trim();
    if (!needle) continue;
    if (lower.includes(needle.toLowerCase()) || text.includes(needle)) {
      matchedSignals.push(needle);
      score += needle.length > 8 ? 2 : 1;
    }
  }

  for (const role of roles) {
    const needle = String(role || '').trim();
    if (!needle) continue;
    if (lower.includes(needle.toLowerCase()) || text.includes(needle)) {
      matchedSignals.push(`role:${needle}`);
      score += 3;
    }
  }

  // Soft boost for contact / apply cues
  if (/@[\w.-]+\.\w+|https?:\/\/|שלח(?:ו)?\s*קו"?ח|send\s+(cv|resume)|להגיש/i.test(text)) {
    matchedSignals.push('contact-or-apply');
    score += 1;
  }

  return {
    isJob: matchedSignals.length > 0 && score >= 1,
    score,
    matchedSignals: [...new Set(matchedSignals)],
  };
}

function groupNameFromFile(filePath) {
  const base = path.basename(filePath, path.extname(filePath));
  return base.replace(/^WhatsApp Chat with\s+/i, '').replace(/^צ'אט WhatsApp עם\s+/i, '') || base;
}

/**
 * Collect .txt export paths from a file or directory.
 * @param {string} exportPath
 * @returns {string[]}
 */
export function resolveExportFiles(exportPath) {
  const resolved = path.resolve(exportPath);
  if (!fs.existsSync(resolved)) {
    const err = new Error(`WhatsApp export path not found: ${resolved}`);
    err.code = 'WA_EXPORT_NOT_FOUND';
    throw err;
  }
  const stat = fs.statSync(resolved);
  if (stat.isFile()) {
    if (!/\.txt$/i.test(resolved)) {
      const err = new Error(`Expected a .txt WhatsApp export file: ${resolved}`);
      err.code = 'WA_EXPORT_INVALID';
      throw err;
    }
    return [resolved];
  }
  return fs
    .readdirSync(resolved)
    .filter((f) => /\.txt$/i.test(f))
    .map((f) => path.join(resolved, f))
    .sort();
}

/**
 * Scan WhatsApp exports for job postings.
 * @param {object} opts
 * @param {string} opts.exportPath - File or directory of WhatsApp .txt exports
 * @param {string[]} [opts.groupNames] - Optional group name filters (substring, case-insensitive)
 * @param {string[]} [opts.keywords] - Extra/override job keywords
 * @param {string[]} [opts.roles] - Desired roles to boost relevance
 * @param {string} [opts.since] - ISO date; ignore older messages
 * @param {number} [opts.limit] - Max jobs to return (default 50)
 * @returns {{ ok: true, scannedFiles: number, messagesScanned: number, jobs: object[] }}
 */
export function scanWhatsappJobs({
  exportPath,
  groupNames = [],
  keywords,
  roles = [],
  since,
  limit = 50,
} = {}) {
  if (!exportPath || !String(exportPath).trim()) {
    const err = new Error('scan_whatsapp_jobs requires exportPath');
    err.code = 'WA_INVALID_ARGS';
    throw err;
  }

  const kw = Array.isArray(keywords) && keywords.length ? keywords : DEFAULT_JOB_KEYWORDS;
  const roleList = Array.isArray(roles) ? roles.map(String) : [];
  const groupFilters = (Array.isArray(groupNames) ? groupNames : [])
    .map((g) => String(g || '').trim().toLowerCase())
    .filter(Boolean);
  const sinceMs = since ? Date.parse(since) : NaN;
  const max = Math.max(1, Math.min(Number(limit) || 50, 500));

  const files = resolveExportFiles(String(exportPath).trim());
  const jobs = [];
  let messagesScanned = 0;

  for (const file of files) {
    const groupName = groupNameFromFile(file);
    if (
      groupFilters.length &&
      !groupFilters.some((g) => groupName.toLowerCase().includes(g))
    ) {
      continue;
    }

    const raw = fs.readFileSync(file, 'utf8');
    const messages = parseWhatsappExport(raw, { groupName });
    messagesScanned += messages.length;

    for (const msg of messages) {
      if (!Number.isNaN(sinceMs) && msg.timestamp) {
        const t = Date.parse(msg.timestamp);
        if (!Number.isNaN(t) && t < sinceMs) continue;
      }

      const scored = scoreJobMessage(msg.body, { keywords: kw, roles: roleList });
      if (!scored.isJob) continue;

      jobs.push({
        id: `${groupName}:${msg.timestamp || 'na'}:${jobs.length}`,
        groupName: msg.groupName,
        timestamp: msg.timestamp,
        author: msg.author,
        text: msg.body.trim(),
        snippet: msg.body.trim().slice(0, 280),
        score: scored.score,
        matchedSignals: scored.matchedSignals,
        sourceFile: path.basename(file),
      });
    }
  }

  jobs.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return String(b.timestamp || '').localeCompare(String(a.timestamp || ''));
  });

  return {
    ok: true,
    scannedFiles: files.length,
    messagesScanned,
    jobCount: Math.min(jobs.length, max),
    jobs: jobs.slice(0, max),
  };
}
