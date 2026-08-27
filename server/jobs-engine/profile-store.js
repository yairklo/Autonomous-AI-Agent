/**
 * Candidate profile + CV on the data volume so GUI updates survive Coolify rebuilds.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config as appConfig } from '../config.js';
import { loadJobsConfig } from '../jobs/jobs-config.js';

const PROFILE_FIELDS = ['name', 'email', 'phone', 'linkedin', 'github'];

export function profilePaths(jobsConfig) {
  const cfg = jobsConfig || loadJobsConfig();
  const profilePath = cfg.profile.path;
  const configuredCv = cfg.profile.cvPath;
  const dataCvPath = configuredCv || path.join(appConfig.root, 'data', 'cv.pdf');
  const assetsCvPath = path.join(appConfig.root, 'assets', 'cv.pdf');
  return { profilePath, dataCvPath, configuredCv, assetsCvPath };
}

function emptyProfile() {
  return {
    name: '',
    email: '',
    phone: '',
    linkedin: '',
    github: '',
    targetRoles: ['Full Stack', 'Backend'],
    cvPath: 'data/cv.pdf',
    coverTemplateHe: '',
    coverTemplateEn: '',
  };
}

export function readCvProfile(jobsConfig) {
  const { profilePath } = profilePaths(jobsConfig);
  if (!fs.existsSync(profilePath)) {
    return { ...emptyProfile(), _exists: false };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    return { ...emptyProfile(), ...parsed, _exists: true };
  } catch {
    const err = new Error('Invalid CV profile JSON');
    err.code = 'CV_PROFILE_INVALID';
    throw err;
  }
}

function cvStat(filePath) {
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile()) return null;
    return { path: filePath, bytes: st.size, updatedAt: st.mtime.toISOString() };
  } catch {
    return null;
  }
}

function profileCvPath(profile, profilePath) {
  const raw = String(profile?.cvPath || '').trim();
  if (!raw) return '';
  if (path.isAbsolute(raw)) return raw;
  const fromProfileDir = path.join(path.dirname(profilePath), raw);
  const fromRoot = path.join(appConfig.root, raw);
  return fs.existsSync(fromProfileDir) ? fromProfileDir : fromRoot;
}

export function cvFileInfo(jobsConfig) {
  const { dataCvPath, configuredCv, assetsCvPath, profilePath } = profilePaths(jobsConfig);
  let profile;
  try {
    profile = readCvProfile(jobsConfig);
  } catch {
    profile = null;
  }
  const fromProfile = profile ? profileCvPath(profile, profilePath) : '';
  return (
    cvStat(dataCvPath) ||
    cvStat(configuredCv) ||
    cvStat(fromProfile) ||
    cvStat(assetsCvPath) ||
    null
  );
}

export function getProfileForGui(jobsConfig) {
  const profile = readCvProfile(jobsConfig);
  const cv = cvFileInfo(jobsConfig);
  return {
    ok: true,
    persistedOnVolume: true,
    volumeHint:
      'Saved under /app/data (Coolify data volume). Updating here does not require a rebuild.',
    profile: {
      name: profile.name || '',
      email: profile.email || '',
      phone: profile.phone || '',
      linkedin: profile.linkedin || '',
      github: profile.github || '',
    },
    cv: cv
      ? {
          present: true,
          bytes: cv.bytes,
          updatedAt: cv.updatedAt,
          storedAs: path.relative(appConfig.root, cv.path).replaceAll('\\', '/'),
        }
      : { present: false, bytes: 0, updatedAt: null, storedAs: 'data/cv.pdf' },
  };
}

export function saveCvProfile(patch, jobsConfig) {
  const { profilePath } = profilePaths(jobsConfig);
  const current = readCvProfile(jobsConfig);
  const next = { ...current };
  delete next._exists;
  for (const key of PROFILE_FIELDS) {
    if (patch[key] !== undefined) next[key] = String(patch[key] || '').trim();
  }
  if (!next.cvPath) next.cvPath = 'data/cv.pdf';
  fs.mkdirSync(path.dirname(profilePath), { recursive: true });
  fs.writeFileSync(profilePath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return getProfileForGui(jobsConfig);
}

function maybeMirrorToAssets(buffer, dataCvPath, assetsCvPath) {
  if (path.resolve(dataCvPath) === path.resolve(assetsCvPath)) return;
  const dataDir = path.resolve(appConfig.root, 'data');
  const rel = path.relative(dataDir, path.resolve(dataCvPath));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return;
  try {
    fs.mkdirSync(path.dirname(assetsCvPath), { recursive: true });
    fs.writeFileSync(assetsCvPath, buffer);
  } catch {
    /* assets may be read-only in some images; data volume is enough */
  }
}

export function saveCvPdf(buffer, originalName = 'cv.pdf', jobsConfig) {
  const { dataCvPath, assetsCvPath, profilePath } = profilePaths(jobsConfig);
  const name = String(originalName || 'cv.pdf').toLowerCase();
  if (!name.endsWith('.pdf')) {
    const err = new Error('CV must be a PDF file');
    err.code = 'CV_NOT_PDF';
    throw err;
  }
  if (!buffer || !buffer.length) {
    const err = new Error('Empty CV upload');
    err.code = 'CV_EMPTY';
    throw err;
  }
  fs.mkdirSync(path.dirname(dataCvPath), { recursive: true });
  fs.writeFileSync(dataCvPath, buffer);
  maybeMirrorToAssets(buffer, dataCvPath, assetsCvPath);
  const current = readCvProfile(jobsConfig);
  current.cvPath = path.relative(appConfig.root, dataCvPath).replaceAll('\\', '/') || 'data/cv.pdf';
  delete current._exists;
  fs.mkdirSync(path.dirname(profilePath), { recursive: true });
  fs.writeFileSync(profilePath, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
  return getProfileForGui(jobsConfig);
}

export function readCvPdfBuffer(jobsConfig) {
  const info = cvFileInfo(jobsConfig);
  if (!info) return null;
  return fs.readFileSync(info.path);
}
