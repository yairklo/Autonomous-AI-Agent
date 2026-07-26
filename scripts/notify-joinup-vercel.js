#!/usr/bin/env node
/**
 * After Dev deploy: resolve the Dev *preview* Vercel URL (not production)
 * and notify ONE Telegram chat — never the whole allow-list.
 *
 * Usage:
 *   node scripts/notify-joinup-vercel.js --chat 5539493039
 *   JOINUP_NOTIFY_CHAT_ID=5539493039 npm run joinup:notify-vercel
 *
 * Requires:
 *   JOINUP_TELEGRAM_BOT_TOKEN
 *   ALLOWED_TELEGRAM_USER_IDS (recipient must be allow-listed)
 *   VERCEL_TOKEN + VERCEL_PROJECT_ID   (preferred)
 *     or GITHUB_TOKEN                 (PR-style deployment / check URL)
 */
import { loadJoinUpTelegramConfig } from '../server/joinup-telegram/config.js';
import {
  formatVercelTelegramLines,
  resolveJoinUpVercelUrl,
} from '../server/joinup-telegram/vercel.js';

function parseChatId(argv) {
  const idx = argv.indexOf('--chat');
  if (idx >= 0 && argv[idx + 1]) return String(argv[idx + 1]).trim();
  const eq = argv.find((a) => a.startsWith('--chat='));
  if (eq) return eq.slice('--chat='.length).trim();
  return String(process.env.JOINUP_NOTIFY_CHAT_ID || '').trim();
}

const config = loadJoinUpTelegramConfig();
if (!config.botToken || config.allowedUserIds.size === 0) {
  console.error('Telegram bot not configured');
  process.exit(1);
}

const chatId = parseChatId(process.argv.slice(2));
if (!chatId) {
  console.error(
    [
      'Refusing to broadcast: pass a single recipient.',
      '  node scripts/notify-joinup-vercel.js --chat <TELEGRAM_USER_ID>',
      '  or set JOINUP_NOTIFY_CHAT_ID=<TELEGRAM_USER_ID>',
    ].join('\n')
  );
  process.exit(1);
}
if (!config.allowedUserIds.has(chatId)) {
  console.error(
    `chat ${chatId} is not in ALLOWED_TELEGRAM_USER_IDS — refusing to send`
  );
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

if (!data.ok) process.exit(1);
if (!vercel.url) process.exit(2);
