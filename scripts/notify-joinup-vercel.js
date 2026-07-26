#!/usr/bin/env node
/**
 * After Dev deploy: resolve the Dev *preview* Vercel URL (not production)
 * and notify the joinUp Telegram allow-list.
 *
 * Requires:
 *   JOINUP_TELEGRAM_BOT_TOKEN
 *   ALLOWED_TELEGRAM_USER_IDS
 *   VERCEL_TOKEN + VERCEL_PROJECT_ID   (preferred)
 *     or GITHUB_TOKEN                 (PR-style deployment / check URL)
 */
import { loadJoinUpTelegramConfig } from '../server/joinup-telegram/config.js';
import {
  formatVercelTelegramLines,
  resolveJoinUpVercelUrl,
} from '../server/joinup-telegram/vercel.js';

const config = loadJoinUpTelegramConfig();
if (!config.botToken || config.allowedUserIds.size === 0) {
  console.error('Telegram bot not configured');
  process.exit(1);
}

const vercel = await resolveJoinUpVercelUrl({
  gitBranch: process.env.JOINUP_VERCEL_BRANCH || 'Dev',
  projectRoot: config.joinUpRoot,
  onLog: (l) => console.log(l),
  timeoutMs: Number(process.env.JOINUP_VERCEL_WAIT_MS || 300000),
  allowProductionFallback: false,
});

const text = [
  'מוכן — העדכון ל-joinUp עלה לענף Dev.',
  '',
  ...formatVercelTelegramLines(vercel),
  '',
  vercel.url
    ? 'זה קישור ה-preview של הבילד (כמו ב-PR ב-GitHub) — לא האתר בפרודקשן.'
    : 'כדי לקבל קישור preview אוטומטית, הוסיפו ל-.env: VERCEL_TOKEN ו-VERCEL_PROJECT_ID (או GITHUB_TOKEN).',
].join('\n');

for (const chatId of config.allowedUserIds) {
  const res = await fetch(
    `https://api.telegram.org/bot${config.botToken}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: false,
      }),
    }
  );
  const data = await res.json();
  console.log(`notify chat=${chatId} ok=${data.ok}`);
}

if (!vercel.url) process.exit(2);
