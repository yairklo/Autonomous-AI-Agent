/**
 * Upload data/job_applications.xlsx to Google Drive using existing OAuth tokens.
 * Creates the file once, then updates the same file id (stored on the data volume).
 */

import fs from 'node:fs';
import path from 'node:path';
import { OAuth2Client } from 'google-auth-library';
import { config as appConfig } from '../config.js';

const TRACKER_FILE = path.join(appConfig.root, 'data', 'job_applications.xlsx');
const STATE_FILE = path.join(appConfig.root, 'data', 'gdrive-jobs-tracker.json');
const CRED_FILE = path.join(appConfig.root, 'data', 'gdrive-credentials.json');
const TOKEN_FILE = path.join(appConfig.root, 'data', 'gdrive-tokens.json');
const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const FILE_NAME = 'job_applications.xlsx';

function hydrateEnvFiles() {
  fs.mkdirSync(path.join(appConfig.root, 'data'), { recursive: true });
  if (process.env.GDRIVE_CREDENTIALS_JSON && !fs.existsSync(CRED_FILE)) {
    fs.writeFileSync(CRED_FILE, process.env.GDRIVE_CREDENTIALS_JSON, 'utf8');
  }
  if (process.env.GDRIVE_TOKENS_JSON && !fs.existsSync(TOKEN_FILE)) {
    fs.writeFileSync(TOKEN_FILE, process.env.GDRIVE_TOKENS_JSON, 'utf8');
  }
}

export function driveTrackerStatus() {
  hydrateEnvFiles();
  const configured = fs.existsSync(CRED_FILE) && fs.existsSync(TOKEN_FILE);
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    state = {};
  }
  return {
    configured,
    trackerPresent: fs.existsSync(TRACKER_FILE),
    fileId: state.fileId || process.env.GDRIVE_JOBS_TRACKER_FILE_ID || '',
    webViewLink: state.webViewLink || '',
    lastSyncedAt: state.lastSyncedAt || null,
    lastError: state.lastError || '',
    howTo: configured
      ? 'Excel at data/job_applications.xlsx. Sync from the Jobs table or it updates after each apply. No redeploy.'
      : 'One-time: put OAuth client JSON in data/gdrive-credentials.json (or Coolify GDRIVE_CREDENTIALS_JSON) and tokens from npm run auth:gdrive in data/gdrive-tokens.json (or GDRIVE_TOKENS_JSON). Same files the Drive MCP already uses. Then click Sync — no rebuild.',
  };
}

function loadOAuthClient() {
  hydrateEnvFiles();
  if (!fs.existsSync(CRED_FILE) || !fs.existsSync(TOKEN_FILE)) {
    const err = new Error(
      'Google Drive is not authorized. Save OAuth client JSON + tokens on the data volume (npm run auth:gdrive), or set GDRIVE_CREDENTIALS_JSON / GDRIVE_TOKENS_JSON.'
    );
    err.code = 'GDRIVE_NOT_CONFIGURED';
    throw err;
  }
  const creds = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8'));
  const tokens = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  const installed = creds.installed || creds.web || {};
  const client = new OAuth2Client(installed.client_id, installed.client_secret);
  client.setCredentials(tokens);
  client.on('tokens', (next) => {
    try {
      const prev = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
      fs.writeFileSync(
        TOKEN_FILE,
        `${JSON.stringify({ ...prev, ...next }, null, 2)}\n`,
        'utf8'
      );
    } catch {
      /* ignore token persist failures */
    }
  });
  return client;
}

function writeState(patch) {
  let prev = {};
  try {
    prev = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    prev = {};
  }
  const next = { ...prev, ...patch, updatedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

async function createXlsx(client, bytes) {
  const boundary = `tracker_${Date.now()}`;
  const metadata = JSON.stringify({ name: FILE_NAME, mimeType: XLSX_MIME });
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${XLSX_MIME}\r\n\r\n`
    ),
    bytes,
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  const res = await client.request({
    url: 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink,name',
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  return res.data;
}

async function updateXlsx(client, fileId, bytes) {
  const res = await client.request({
    url: `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=media&fields=id,webViewLink,name`,
    method: 'PATCH',
    headers: { 'Content-Type': XLSX_MIME },
    body: bytes,
  });
  return res.data;
}

/**
 * @returns {Promise<{ ok: boolean, skipped?: boolean, fileId?: string, webViewLink?: string, error?: string, code?: string }>}
 */
export async function syncTrackerToDrive({ onLog = () => {} } = {}) {
  if (!fs.existsSync(TRACKER_FILE)) {
    return { ok: false, skipped: true, code: 'NO_TRACKER', error: 'Excel tracker not created yet' };
  }
  try {
    const client = loadOAuthClient();
    const bytes = fs.readFileSync(TRACKER_FILE);
    const status = driveTrackerStatus();
    let data;
    if (status.fileId) {
      try {
        data = await updateXlsx(client, status.fileId, bytes);
      } catch (err) {
        onLog(`[gdrive-tracker] update failed (${err.message}) — creating a new file`);
        data = await createXlsx(client, bytes);
      }
    } else {
      data = await createXlsx(client, bytes);
    }
    const saved = writeState({
      fileId: data.id,
      webViewLink: data.webViewLink || '',
      lastSyncedAt: new Date().toISOString(),
      lastError: '',
    });
    onLog(`[gdrive-tracker] synced fileId=${saved.fileId}`);
    return {
      ok: true,
      fileId: saved.fileId,
      webViewLink: saved.webViewLink,
      lastSyncedAt: saved.lastSyncedAt,
    };
  } catch (err) {
    writeState({ lastError: err.message });
    return {
      ok: false,
      error: err.message,
      code: err.code || 'GDRIVE_SYNC_FAILED',
    };
  }
}
