#!/usr/bin/env node
/**
 * Standalone entrypoint for the joinUp Telegram Product Bot.
 *
 * Required .env (repo root):
 *   JOINUP_TELEGRAM_BOT_TOKEN=...
 *   ALLOWED_TELEGRAM_USER_IDS=123456789,987654321
 *   JOINUP_PROJECT_ROOT=C:\JoinUpApp
 *
 * Optional:
 *   JOINUP_TELEGRAM_MOCK=1   # canned grilling replies (no Claude CLI)
 */
import { startJoinUpTelegramService } from '../server/joinup-telegram/index.js';

const service = await startJoinUpTelegramService({
  onLog: (line) => console.log(line),
});

if (!service) {
  console.error(
    [
      'joinUp Telegram bot is not configured.',
      '',
      'Add these to your .env file in the repo root:',
      '  JOINUP_TELEGRAM_BOT_TOKEN=<token from @BotFather>',
      '  ALLOWED_TELEGRAM_USER_IDS=<comma-separated Telegram user IDs>',
      '  JOINUP_PROJECT_ROOT=<absolute path to the joinUp repository>',
      '',
      'Then re-run: npm run joinup:telegram',
    ].join('\n')
  );
  process.exit(1);
}

console.log('[joinup-telegram] running. Press Ctrl+C to stop.');
