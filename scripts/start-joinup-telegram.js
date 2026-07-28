#!/usr/bin/env node
/**
 * Coolify entry for thin joinUp Telegram bot:
 * wait for voice-agent health, then long-poll Telegram.
 * No Claude/Cursor/bootstrap of coding workspaces in this container.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveVoiceAgentBaseUrl } from '../server/joinup-telegram/voice-agent-url.js';
import { waitForVoiceAgentHealth } from '../server/joinup-telegram/voice-agent-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

async function main() {
  const voiceUrl = resolveVoiceAgentBaseUrl();
  console.log(`[joinup-telegram] VOICE_AGENT_URL effective=${voiceUrl}`);
  if (/127\.0\.0\.1|localhost/i.test(voiceUrl)) {
    console.warn(
      '[joinup-telegram] VOICE_AGENT_URL looks local. In Coolify set VOICE_AGENT_URL ' +
        'to the voice-agent application URL.'
    );
  }
  if (!String(process.env.JOINUP_BOT_SHARED_SECRET || '').trim()) {
    throw new Error(
      'JOINUP_BOT_SHARED_SECRET is required (must match voice-agent)'
    );
  }
  if (!String(process.env.JOINUP_TELEGRAM_BOT_TOKEN || '').trim()) {
    throw new Error('JOINUP_TELEGRAM_BOT_TOKEN is required');
  }

  await waitForVoiceAgentHealth({
    maxAttempts: Number(process.env.JOINUP_VOICE_HEALTH_ATTEMPTS || 10),
    baseDelayMs: Number(process.env.JOINUP_VOICE_HEALTH_DELAY_MS || 1000),
    onLog: (line) => console.log(line),
  });

  const bot = path.join(repoRoot, 'scripts', 'joinup-telegram-bot.js');
  const child = spawn(process.execPath, [bot], {
    cwd: repoRoot,
    env: {
      ...process.env,
      JOINUP_THIN_BOT: process.env.JOINUP_THIN_BOT || '1',
      AGENT_ACTIVITY_PERSIST: '0',
    },
    stdio: 'inherit',
  });

  const forward = (signal) => {
    try {
      child.kill(signal);
    } catch {
      /* ignore */
    }
  };
  process.on('SIGINT', () => forward('SIGINT'));
  process.on('SIGTERM', () => forward('SIGTERM'));

  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 1);
  });
}

main().catch((err) => {
  console.error(`[joinup-telegram] start failed: ${err.message}`);
  process.exit(1);
});
