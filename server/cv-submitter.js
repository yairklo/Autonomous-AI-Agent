import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { extractApplyContacts } from './whatsapp-job-scanner.js';

/**
 * Local CV application drafter for WhatsApp-discovered jobs (v1).
 * Writes draft packages under data/cv-applications — never sends live WhatsApp.
 */

export function loadCvProfile(profilePath) {
  const resolved = path.resolve(String(profilePath || '').trim());
  if (!profilePath || !String(profilePath).trim()) {
    const err = new Error('submit_whatsapp_job_cv requires profilePath');
    err.code = 'CV_INVALID_ARGS';
    throw err;
  }
  if (!fs.existsSync(resolved)) {
    const err = new Error(`CV profile not found: ${resolved}`);
    err.code = 'CV_PROFILE_NOT_FOUND';
    throw err;
  }
  let profile;
  try {
    profile = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (err) {
    const e = new Error(`Invalid CV profile JSON: ${resolved}`);
    e.code = 'CV_PROFILE_INVALID';
    e.cause = err;
    throw e;
  }
  return { ...profile, _profilePath: resolved, _profileDir: path.dirname(resolved) };
}

function resolveAttachedCvPath(profile, cvPathOverride) {
  if (cvPathOverride && String(cvPathOverride).trim()) {
    const abs = path.resolve(String(cvPathOverride).trim());
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      const err = new Error(`CV file not found: ${abs}`);
      err.code = 'CV_NOT_FOUND';
      throw err;
    }
    return abs;
  }
  const raw = String(profile.cvPath || '').trim();
  if (!raw) {
    const err = new Error('CV profile is missing cvPath');
    err.code = 'CV_INVALID_ARGS';
    throw err;
  }
  const candidates = [
    path.isAbsolute(raw) ? raw : null,
    path.join(profile._profileDir, raw),
    path.resolve(raw),
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  const err = new Error(`CV file not found: ${raw}`);
  err.code = 'CV_NOT_FOUND';
  throw err;
}

function buildCoverNote({ profile, jobText, coverNote }) {
  if (coverNote != null && String(coverNote).trim()) return String(coverNote).trim();
  const useHe = /[\u0590-\u05FF]/.test(String(jobText || ''));
  const template =
    (useHe ? profile.coverTemplateHe : profile.coverTemplateEn) ||
    profile.coverTemplateEn ||
    profile.coverTemplateHe ||
    'Hello,\n\nPlease find my CV attached.\n\n{name}';
  return String(template).replaceAll('{name}', profile.name || 'Candidate').trim();
}

export function submitWhatsappJobCv({
  jobId,
  jobText = '',
  groupName = '',
  author = '',
  recipientEmail,
  coverNote,
  profilePath,
  applicationsDir,
  cvPath,
  confirm = false,
} = {}) {
  const text = String(jobText || '').trim();
  if (!text && !recipientEmail) {
    const err = new Error('submit_whatsapp_job_cv requires jobText or recipientEmail');
    err.code = 'CV_INVALID_ARGS';
    throw err;
  }
  if (!applicationsDir || !String(applicationsDir).trim()) {
    const err = new Error('submit_whatsapp_job_cv requires applicationsDir');
    err.code = 'CV_INVALID_ARGS';
    throw err;
  }

  const profile = loadCvProfile(profilePath);
  const attachedCv = resolveAttachedCvPath(profile, cvPath);
  const contacts = extractApplyContacts(text);
  if (recipientEmail && String(recipientEmail).trim()) {
    const email = String(recipientEmail).trim().toLowerCase();
    if (!contacts.emails.includes(email)) contacts.emails.unshift(email);
  }

  const toEmail = contacts.emails[0] || null;
  const note = buildCoverNote({ profile, jobText: text, coverNote });
  const id = randomUUID();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const baseName = `${stamp}_${id.slice(0, 8)}`;
  const dir = path.resolve(String(applicationsDir).trim());
  fs.mkdirSync(dir, { recursive: true });

  const jsonPath = path.join(dir, `${baseName}.json`);
  const coverPath = path.join(dir, `${baseName}-cover.txt`);
  const cvCopyPath = path.join(dir, `${baseName}-cv${path.extname(attachedCv) || '.bin'}`);
  fs.writeFileSync(coverPath, note, 'utf8');
  fs.copyFileSync(attachedCv, cvCopyPath);

  const subject = groupName
    ? `CV — ${groupName}${author ? ` / ${author}` : ''}`
    : `CV application${author ? ` — ${author}` : ''}`;
  const mailto = toEmail
    ? `mailto:${encodeURIComponent(toEmail)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(note)}`
    : null;

  const status = confirm ? 'ready_to_send' : 'draft';
  const application = {
    id,
    status,
    confirm: Boolean(confirm),
    createdAt: new Date().toISOString(),
    candidate: {
      name: profile.name || null,
      email: profile.email || null,
      phone: profile.phone || null,
      targetRoles: profile.targetRoles || [],
    },
    job: {
      id: jobId || null,
      groupName: groupName || null,
      author: author || null,
      text: text || null,
      snippet: text ? text.slice(0, 280) : null,
    },
    contacts,
    mailto,
    note:
      status === 'ready_to_send'
        ? 'Marked ready_to_send after user approval. Open mailto or send cover + CV manually (no live WhatsApp send).'
        : toEmail
          ? 'Draft prepared. Review cover note, then confirm to mark ready_to_send (still no live send).'
          : 'Draft prepared without email — add recipientEmail or reply in the WhatsApp group / DM.',
  };

  fs.writeFileSync(jsonPath, JSON.stringify(application, null, 2), 'utf8');
  return { ok: true, application, files: { json: jsonPath, cover: coverPath, cv: cvCopyPath } };
}
