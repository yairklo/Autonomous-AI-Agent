/**
 * Forward joinUp Telegram conversation milestones to the host activity history.
 * Host GUI only — never sends this data back to Telegram collaborators.
 */
import { loadDotEnv } from './load-env.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveVoiceAgentBaseUrl } from './voice-agent-url.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadDotEnv(path.resolve(__dirname, '..', '..', '.env'));

function agentBaseUrl() {
  return resolveVoiceAgentBaseUrl();
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
  return id ? `Telegram ...${id.slice(-4)}` : 'Telegram';
}
