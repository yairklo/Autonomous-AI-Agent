/**
 * Forward joinUp Telegram / Cursor logs to the voice-agent live run console.
 * Uses HTTP so the bot can run as a separate process from `npm start`.
 */
import { loadDotEnv } from './load-env.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadDotEnv(path.resolve(__dirname, '..', '..', '.env'));

function agentBaseUrl() {
  const port = process.env.PORT || '8787';
  const host = process.env.JOINUP_RUN_LOG_HOST || '127.0.0.1';
  return (process.env.JOINUP_RUN_LOG_URL || `http://${host}:${port}`).replace(/\/$/, '');
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
      console.warn(`[run-log-bridge] ${pathname} HTTP ${res.status} ${text.slice(0, 120)}`);
      return null;
    }
    return await res.json().catch(() => ({}));
  } catch (err) {
    // Voice-agent server may be down — keep Telegram bot usable.
    console.warn(`[run-log-bridge] ${pathname} failed: ${err.message}`);
    return null;
  }
}

export async function bridgeStartRun({ source = 'joinup-telegram', project = '', title = '' } = {}) {
  const data = await postJson('/api/runs/start', { source, project, title });
  return data?.runId || null;
}

export async function bridgeLogLine(runId, line, { source = 'joinup-telegram', project = '' } = {}) {
  console.log(line);
  if (!runId) return;
  await postJson('/api/runs/events', { runId, line, source, project });
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
