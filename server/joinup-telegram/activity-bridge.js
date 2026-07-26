/**
 * Forward joinUp Telegram conversation milestones to the host activity history.
 * Host GUI only — never sends this data back to Telegram collaborators.
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

/**
 * @param {object} payload
 */
export async function bridgeActivity(payload) {
  const url = `${agentBaseUrl()}/api/activity`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn(
        `[activity-bridge] HTTP ${res.status} ${text.replace(/\s+/g, ' ').slice(0, 100)}`
      );
    }
  } catch (err) {
    console.warn(`[activity-bridge] failed: ${err.message}`);
  }
}

export function telegramActivityId(userId) {
  const day = new Date().toISOString().slice(0, 10);
  return `telegram:${userId}:${day}`;
}

export function telegramActorLabel(userId) {
  const id = String(userId || '');
  return id ? `Telegram · …${id.slice(-4)}` : 'Telegram';
}
