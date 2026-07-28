/**
 * Parked coding tasks waiting for CLI auth recovery.
 * Metadata only — never stores tokens. File: data/cli-auth-queue.json
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');

export function defaultQueuePath(env = process.env) {
  return (
    String(env.CLI_AUTH_QUEUE_PATH || '').trim() ||
    path.join(root, 'data', 'cli-auth-queue.json')
  );
}

function emptyStore() {
  return { version: 1, items: [] };
}

/**
 * @param {string} [filePath]
 */
export function loadQueue(filePath = defaultQueuePath()) {
  try {
    if (!fs.existsSync(filePath)) return emptyStore();
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!raw || !Array.isArray(raw.items)) return emptyStore();
    return { version: 1, items: raw.items };
  } catch {
    return emptyStore();
  }
}

/**
 * @param {{ version: number, items: object[] }} store
 * @param {string} [filePath]
 */
export function saveQueue(store, filePath = defaultQueuePath()) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

/**
 * @param {object} entry
 * @param {object} [opts]
 */
export function parkTask(entry, { filePath, env = process.env } = {}) {
  const queueFile = filePath || defaultQueuePath(env);
  const waitMs = Number(env.CLI_AUTH_WAIT_MS || 1_800_000);
  const store = loadQueue(queueFile);
  const id = entry.id || randomUUID();
  const now = Date.now();
  const item = {
    id,
    status: 'awaiting_cli_auth',
    tool: entry.tool || 'cursor',
    project: String(entry.project || ''),
    task: String(entry.task || '').slice(0, 4000),
    runId: entry.runId || '',
    authUrl: entry.authUrl || '',
    reason: entry.reason || '',
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + Math.max(60_000, waitMs || 60_000)).toISOString(),
    resumeRequestedAt: null,
  };
  // Allow short waits in tests without instant expiry on park.
  if (waitMs > 0 && waitMs < 60_000) {
    item.expiresAt = new Date(now + waitMs).toISOString();
  }
  store.items = store.items.filter((x) => x.id !== id);
  store.items.push(item);
  saveQueue(store, queueFile);
  return item;
}

export function listParked(filePath = defaultQueuePath()) {
  expireParked({ filePath });
  return loadQueue(filePath).items.filter((x) => x.status === 'awaiting_cli_auth');
}

export function getParked(id, filePath = defaultQueuePath()) {
  return loadQueue(filePath).items.find((x) => x.id === id) || null;
}

export function removeParked(id, filePath = defaultQueuePath()) {
  const store = loadQueue(filePath);
  const before = store.items.length;
  store.items = store.items.filter((x) => x.id !== id);
  saveQueue(store, filePath);
  return before !== store.items.length;
}

export function markResumeRequested(id, filePath = defaultQueuePath()) {
  const store = loadQueue(filePath);
  const item = store.items.find((x) => x.id === id);
  if (!item) return null;
  item.resumeRequestedAt = new Date().toISOString();
  saveQueue(store, filePath);
  return item;
}

/** Mark all awaiting items as resume-requested (operator /retry). */
export function markAllResumeRequested(filePath = defaultQueuePath()) {
  const store = loadQueue(filePath);
  const now = new Date().toISOString();
  let n = 0;
  for (const item of store.items) {
    if (item.status === 'awaiting_cli_auth') {
      item.resumeRequestedAt = now;
      n += 1;
    }
  }
  saveQueue(store, filePath);
  return n;
}

export function expireParked({ filePath = defaultQueuePath(), now = Date.now() } = {}) {
  const store = loadQueue(filePath);
  let changed = false;
  for (const item of store.items) {
    if (item.status !== 'awaiting_cli_auth') continue;
    const exp = Date.parse(item.expiresAt || '');
    if (Number.isFinite(exp) && exp <= now) {
      item.status = 'expired';
      changed = true;
    }
  }
  if (changed) saveQueue(store, filePath);
  return store.items.filter((x) => x.status === 'expired');
}
