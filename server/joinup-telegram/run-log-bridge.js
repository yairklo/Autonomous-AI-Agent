/**
 * Forward joinUp Telegram / Cursor logs to the voice-agent live run console.
 * Uses HTTP so the bot can run as a separate process from `npm start`.
 *
 * Requires a voice-agent server that exposes /api/runs/* (restart `npm start`
 * after pulling live-log changes). Stale servers return 404 and the GUI stays empty.
 */
import { loadDotEnv } from './load-env.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadDotEnv(path.resolve(__dirname, '..', '..', '.env'));

let warnedBridgeDown = false;
/** Lazy run id when bridgeStartRun failed earlier (e.g. server was stale) then recovered. */
let lazyRunId = null;
let lazyRunMeta = { source: 'joinup-telegram', project: '', title: '' };

function agentBaseUrl() {
  const port = process.env.PORT || '8787';
  const host = process.env.JOINUP_RUN_LOG_HOST || '127.0.0.1';
  return (process.env.JOINUP_RUN_LOG_URL || `http://${host}:${port}`).replace(/\/$/, '');
}

function warnBridgeOnce(detail) {
  if (warnedBridgeDown) return;
  warnedBridgeDown = true;
  console.warn(
    `[run-log-bridge] Live logs NOT reaching GUI (${detail}). ` +
      `Restart voice-agent: npm start  (need /api/runs on ${agentBaseUrl()})`
  );
}

async function postJson(pathname, body) {
  const url = `${agentBaseUrl()}${pathname}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const snippet = text.replace(/\s+/g, ' ').slice(0, 120);
      if (res.status === 404) {
        warnBridgeOnce(`HTTP 404 on ${pathname} — server is too old / wrong process`);
      } else {
        console.warn(`[run-log-bridge] ${pathname} HTTP ${res.status} ${snippet}`);
      }
      return null;
    }
    warnedBridgeDown = false;
    return await res.json().catch(() => ({}));
  } catch (err) {
    // Voice-agent server may be down — keep Telegram bot usable.
    warnBridgeOnce(err.message);
    return null;
  }
}

export async function bridgeStartRun({ source = 'joinup-telegram', project = '', title = '' } = {}) {
  lazyRunMeta = { source, project, title };
  const data = await postJson('/api/runs/start', { source, project, title });
  lazyRunId = data?.runId || null;
  return lazyRunId;
}

export async function bridgeLogLine(runId, line, { source = 'joinup-telegram', project = '' } = {}) {
  console.log(line);
  let id = runId || lazyRunId;
  if (!id) {
    // Server may have been restarted mid-run — open a run on first successful log post.
    id = await bridgeStartRun({
      source: source || lazyRunMeta.source,
      project: project || lazyRunMeta.project,
      title: lazyRunMeta.title || String(line || '').slice(0, 120),
    });
  }
  if (!id) return;
  await postJson('/api/runs/events', { runId: id, line, source, project });
}

export async function bridgeEndRun(runId, { ok = true, text = '' } = {}) {
  if (!runId) return;
  await postJson('/api/runs/end', { runId, ok, text });
}

/**
 * onLog compatible helper for startJoinUpTelegramService.
 */
export function createBridgedOnLog({ runIdRef, project = '' } = {}) {
  return (line) => {
    const runId = typeof runIdRef === 'function' ? runIdRef() : runIdRef?.current;
    void bridgeLogLine(runId, line, { project });
  };
}
