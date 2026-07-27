#!/usr/bin/env node
/**
 * Coolify / production entry for the joinUp Telegram Coolify app:
 * bootstrap JoinUpApp workspace, then start the Telegram bot.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrapWorkspace } from './bootstrap-workspace.js';
import { resolveVoiceAgentBaseUrl } from '../server/joinup-telegram/voice-agent-url.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

async function main() {
  await bootstrapWorkspace();

  const voiceUrl = resolveVoiceAgentBaseUrl();
  console.log(`[joinup-telegram] VOICE_AGENT_URL effective=${voiceUrl}`);
  if (/127\.0\.0\.1|localhost/i.test(voiceUrl)) {
    console.warn(
      '[joinup-telegram] VOICE_AGENT_URL looks local. In Coolify set VOICE_AGENT_URL ' +
        'to the voice-agent application URL so Cursor Live / History receive logs.'
    );
  }

  const bot = path.join(repoRoot, 'scripts', 'joinup-telegram-bot.js');
  const child = spawn(process.execPath, [bot], {
    cwd: repoRoot,
    env: process.env,
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
  console.error(`[joinup-telegram] bootstrap/start failed: ${err.message}`);
  process.exit(1);
});
