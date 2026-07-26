import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDotEnv } from './load-env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const agentRoot = path.resolve(__dirname, '..', '..');

loadDotEnv(path.join(agentRoot, '.env'));

function env(name, fallback = '') {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : String(v).trim();
}

/**
 * Parse comma-separated Telegram user/chat IDs into a Set of numeric strings.
 * @param {string} raw
 * @returns {Set<string>}
 */
export function parseAllowedUserIds(raw) {
  const set = new Set();
  for (const part of String(raw || '').split(',')) {
    const id = part.trim();
    if (!id) continue;
    // Normalize: accept digits only (Telegram user ids are integers).
    if (/^-?\d+$/.test(id)) set.add(id);
  }
  return set;
}

/**
 * Resolve and validate the joinUp project root.
 * Execution is always pinned here — never derived from user/chat input.
 */
export function resolveJoinUpRoot(rawPath = env('JOINUP_PROJECT_ROOT')) {
  const candidate =
    rawPath ||
    // Coolify/Docker default; Windows local sibling layout as fallback.
    (process.platform === 'win32'
      ? path.resolve('C:\\JoinUpApp')
      : '/workspaces/JoinUpApp');
  const resolved = path.resolve(candidate);

  if (!fs.existsSync(resolved)) {
    const err = new Error(
      `JOINUP_PROJECT_ROOT does not exist: ${resolved}. Set JOINUP_PROJECT_ROOT in .env.`
    );
    err.code = 'JOINUP_ROOT_MISSING';
    throw err;
  }
  if (!fs.statSync(resolved).isDirectory()) {
    const err = new Error(`JOINUP_PROJECT_ROOT is not a directory: ${resolved}`);
    err.code = 'JOINUP_ROOT_NOT_DIR';
    throw err;
  }
  return resolved;
}

/**
 * Ensure a path stays strictly inside the joinUp root (no escape).
 * @param {string} joinUpRoot
 * @param {string} [candidate]
 * @returns {string} always the joinUp root (candidates outside are rejected)
 */
export function pinToJoinUpRoot(joinUpRoot, candidate) {
  const root = path.resolve(joinUpRoot);
  if (candidate == null || candidate === '') return root;

  const resolved = path.resolve(candidate);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (resolved !== root && !resolved.startsWith(rootWithSep)) {
    const err = new Error(
      `Refusing path outside joinUp root. Requested=${resolved} root=${root}`
    );
    err.code = 'JOINUP_PATH_ESCAPE';
    throw err;
  }
  // Bot may only dispatch against the project root, never arbitrary subpaths as cwd for shell.
  return root;
}

/**
 * @param {NodeJS.ProcessEnv} [envSource]
 */
export function loadJoinUpTelegramConfig(envSource = process.env) {
  const botToken = String(envSource.JOINUP_TELEGRAM_BOT_TOKEN || '').trim();
  const allowedUserIds = parseAllowedUserIds(
    envSource.ALLOWED_TELEGRAM_USER_IDS || ''
  );
  const joinUpRoot = envSource.JOINUP_PROJECT_ROOT
    ? path.resolve(String(envSource.JOINUP_PROJECT_ROOT).trim())
    : resolveJoinUpRoot();

  return {
    agentRoot,
    botToken,
    allowedUserIds,
    joinUpRoot: pinToJoinUpRoot(joinUpRoot, joinUpRoot),
    mock: String(envSource.JOINUP_TELEGRAM_MOCK || envSource.VOICE_AGENT_MOCK || '0') === '1',
    sessionsFile: path.join(agentRoot, 'data', 'joinup-telegram-sessions.json'),
    stateFile: path.join(agentRoot, 'data', 'joinup-telegram-state.json'),
    claudeBin: String(envSource.CLAUDE_BIN || 'claude').trim() || 'claude',
    configured: Boolean(botToken && allowedUserIds.size > 0),
  };
}

export { agentRoot };
