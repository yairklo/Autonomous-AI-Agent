/**
 * Server-side joinUp product agent singleton (used by /api/joinup/*).
 * Runs on voice-agent — Claude + Cursor stay here, not in the thin Telegram container.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JoinUpCursorExecutor } from './joinup-telegram/executor.js';
import { JoinUpProductAgent } from './joinup-telegram/product-agent.js';
import { JoinUpSessionStore } from './joinup-telegram/session-store.js';
import {
  getWorkspace,
  resolveWorkspaceRoot,
} from './workspaces.js';
import { resolveJoinUpRoot } from './joinup-telegram/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const agentRoot = path.resolve(__dirname, '..');

/** @type {{ store: JoinUpSessionStore, agent: JoinUpProductAgent, executor: JoinUpCursorExecutor, joinUpRoot: string } | null} */
let singleton = null;

/** Extra per-run payload for Telegram polling (vercel/staging). */
const joinupRunExtras = new Map();

export function resolveJoinUpRootForServer() {
  try {
    const ws = getWorkspace('joinup');
    if (ws) {
      const root = resolveWorkspaceRoot(ws);
      if (root) return root;
    }
  } catch {
    /* fall through */
  }
  return resolveJoinUpRoot();
}

export function getJoinUpService(options = {}) {
  if (singleton && !options.forceNew) return singleton;

  const joinUpRoot = options.joinUpRoot || resolveJoinUpRootForServer();
  const store = new JoinUpSessionStore({
    stateFile: path.join(agentRoot, 'data', 'joinup-telegram-state.json'),
  });
  const executor = new JoinUpCursorExecutor({
    joinUpRoot,
    // Runs are local on voice-agent — no HTTP bridge back to self.
    bridge: false,
  });
  const agent = new JoinUpProductAgent({
    store,
    executor,
    mock:
      String(process.env.JOINUP_TELEGRAM_MOCK || process.env.VOICE_AGENT_MOCK || '0') ===
      '1',
    sessionsFile: path.join(agentRoot, 'data', 'joinup-telegram-sessions.json'),
    claudeBin: process.env.CLAUDE_BIN || 'claude',
    onLog: options.onLog || ((line) => console.log(line)),
  });

  singleton = { store, agent, executor, joinUpRoot };
  return singleton;
}

/**
 * @param {string} runId
 * @param {object} extras
 */
export function setJoinUpRunExtras(runId, extras) {
  joinupRunExtras.set(String(runId), {
    ...(joinupRunExtras.get(String(runId)) || {}),
    ...extras,
    updatedAt: new Date().toISOString(),
  });
}

export function getJoinUpRunExtras(runId) {
  return joinupRunExtras.get(String(runId)) || null;
}

/**
 * Map Telegram user id from clientId `joinup-tg:{id}`.
 */
export function userIdFromClientId(clientId) {
  const s = String(clientId || '').trim();
  const m = /^joinup-tg:(.+)$/i.exec(s);
  return m ? m[1] : s;
}

export function clientIdForUser(userId) {
  return `joinup-tg:${userId}`;
}
