import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function env(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

export const config = {
  root,
  host: env('HOST', '0.0.0.0'),
  port: Number(env('PORT', '8787')),
  claudeBin: env('CLAUDE_BIN', 'claude'),
  mock: env('VOICE_AGENT_MOCK', '0') === '1',
  whisperBin: env('WHISPER_BIN', ''),
  whisperModel: env('WHISPER_MODEL', ''),
  uploadsDir: path.join(root, 'uploads'),
  sessionsFile: path.join(root, 'sessions.json'),
  clientDir: path.join(root, 'client'),
  maxUploadBytes: 25 * 1024 * 1024,
  claudeTimeoutMs: Number(env('CLAUDE_TIMEOUT_MS', String(5 * 60 * 1000))),
  systemPrompt: env(
    'VOICE_SYSTEM_PROMPT',
    [
      'You are a personal voice assistant running on the user\'s local machine.',
      'Reply in concise spoken language: short paragraphs, no markdown tables,',
      'no code fences unless the user asks for code, avoid emoji spam.',
      'Prefer answers that take under 20 seconds to speak aloud.',
      `Host: ${os.hostname()}. Date context: ${new Date().toISOString().slice(0, 10)}.`,
    ].join(' ')
  ),
};
