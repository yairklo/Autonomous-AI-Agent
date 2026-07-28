/**
 * joinUp Telegram Product Bot
 * ---------------------------
 * Dedicated Telegram service for non-technical collaborators to specify
 * joinUp features. All Cursor Agent execution is pinned to JOINUP_PROJECT_ROOT.
 *
 * Setup (.env in the Autonomous AI Agent repo root):
 *
 *   JOINUP_TELEGRAM_BOT_TOKEN=123456:ABC...     # from @BotFather
 *   ALLOWED_TELEGRAM_USER_IDS=11111111,22222222 # Telegram user IDs allow-list
 *   JOINUP_PROJECT_ROOT=C:\JoinUpApp            # absolute path to joinUp repo
 *   JOINUP_TELEGRAM_MOCK=1                      # optional: mock LLM (no Claude)
 *
 * Run standalone (local or Coolify Dockerfile.joinup-telegram):
 *   npm run joinup:telegram
 *   npm run start:joinup-telegram   # bootstrap workspace + bot (Coolify entry)
 *
 * Cross-service bridges POST to VOICE_AGENT_URL (or JOINUP_RUN_LOG_URL).
 *
 * Or auto-start with the voice-agent server when JOINUP_TELEGRAM_BOT_TOKEN is set
 * and JOINUP_TELEGRAM_AUTOSTART=1 (not recommended on Coolify — use a separate app).
 */

export { loadJoinUpTelegramConfig, parseAllowedUserIds, pinToJoinUpRoot, resolveJoinUpRoot } from './config.js';
export { resolveVoiceAgentBaseUrl } from './voice-agent-url.js';
export { isAllowedTelegramUser, createAuthMiddleware } from './auth.js';
export { JOINUP_PRODUCT_AGENT_SYSTEM_PROMPT, JOINUP_WELCOME_MESSAGE } from './prompt.js';
export {
  JoinUpSessionStore,
  isExplicitConfirmation,
  isCancelOrReset,
  extractReadyToBuild,
  claimsSendingToBuild,
} from './session-store.js';
export { JoinUpCursorExecutor, formatCompletionMessage, assertPinnedProjectPath } from './executor.js';
export { JoinUpProductAgent } from './product-agent.js';
export { createJoinUpTelegramBot, launchJoinUpTelegramBot } from './bot.js';
export {
  resolveJoinUpVercelUrl,
  formatVercelTelegramLines,
} from './vercel.js';
export {
  redeployAndWatchStaging,
  formatStagingTelegramLines,
  getJoinUpStagingUrl,
  getJoinUpApiProductionUrl,
  detectServerCodeChanges,
} from './render-staging.js';

import { loadJoinUpTelegramConfig } from './config.js';
import { createJoinUpTelegramBot, launchJoinUpTelegramBot } from './bot.js';

/**
 * Start the bot from config / env. No-ops (with log) if not configured.
 * @param {{ onLog?: (line: string) => void, force?: boolean }} [options]
 */
export async function startJoinUpTelegramService(options = {}) {
  // Persist activity via HTTP bridge to voice-agent only (host GUI history).
  process.env.AGENT_ACTIVITY_PERSIST = '0';
  process.env.JOINUP_THIN_BOT = process.env.JOINUP_THIN_BOT || '1';
  const onLog = options.onLog || ((line) => console.log(line));
  const config = loadJoinUpTelegramConfig();

  if (!config.botToken) {
    onLog('[joinup-telegram] skipped: JOINUP_TELEGRAM_BOT_TOKEN not set');
    return null;
  }
  if (config.allowedUserIds.size === 0) {
    onLog('[joinup-telegram] skipped: ALLOWED_TELEGRAM_USER_IDS is empty');
    return null;
  }

  onLog(
    `[joinup-telegram] thin mode → voice-agent (JoinUp coding pinned server-side)`
  );
  onLog(
    `[joinup-telegram] allow-list size: ${config.allowedUserIds.size} mock=${config.mock}`
  );

  const instance = createJoinUpTelegramBot(config, { onLog });
  const { stop } = await launchJoinUpTelegramBot(instance, { onLog });
  return { config, ...instance, stop };
}
