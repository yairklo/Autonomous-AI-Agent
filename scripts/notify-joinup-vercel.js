#!/usr/bin/env node
/**
 * After Dev deploy: resolve Vercel URL and notify the joinUp Telegram allow-list.
 *
 * Requires in .env:
 *   JOINUP_TELEGRAM_BOT_TOKEN
 *   ALLOWED_TELEGRAM_USER_IDS
 *   JOINUP_VERCEL_PRODUCTION_URL   (stable URL — always sent)
 * Optional:
 *   VERCEL_TOKEN + VERCEL_PROJECT_ID/NAME to wait for READY deploy
 */
import {
  loadJoinUpTelegramConfig,
} from '../server/joinup-telegram/config.js';
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
  gitBranch: 'Dev',
  onLog: (l) => console.log(l),
  timeoutMs: Number(process.env.JOINUP_VERCEL_WAIT_MS || 240000),
});

const text = [
  'מוכן — תיקון הבילד של joinUp עלה ל-Dev.',
  '',
  ...formatVercelTelegramLines(vercel),
  '',
  'אפשר לפתוח ולבדוק שהגרסה באוויר עובדת.',
].join('\n');

for (const chatId of config.allowedUserIds) {
  const res = await fetch(
    `https://api.telegram.org/bot${config.botToken}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: false }),
    }
  );
  const data = await res.json();
  console.log(`notify chat=${chatId} ok=${data.ok}`);
}

if (!vercel.url) {
  console.error(
    'No Vercel URL. Set JOINUP_VERCEL_PRODUCTION_URL in .env (and optionally VERCEL_TOKEN).'
  );
  process.exit(2);
}
