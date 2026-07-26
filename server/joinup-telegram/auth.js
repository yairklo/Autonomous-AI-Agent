/**
 * Authorization for the joinUp Telegram bot.
 * Only Telegram user IDs listed in ALLOWED_TELEGRAM_USER_IDS may interact.
 */

/**
 * @param {Set<string>|string[]} allowedUserIds
 * @param {string|number|null|undefined} userId
 * @returns {boolean}
 */
export function isAllowedTelegramUser(allowedUserIds, userId) {
  if (userId == null || userId === '') return false;
  const id = String(userId).trim();
  if (!id) return false;
  const set =
    allowedUserIds instanceof Set
      ? allowedUserIds
      : new Set(
          [...(allowedUserIds || [])].map((x) => String(x).trim()).filter(Boolean)
        );
  if (set.size === 0) return false;
  return set.has(id);
}

/**
 * Telegraf middleware: drop unauthorized updates silently (or reply once).
 * @param {Set<string>} allowedUserIds
 * @param {{ replyUnauthorized?: boolean, unauthorizedMessage?: string, onRejected?: (ctx: any) => void }} [options]
 */
export function createAuthMiddleware(allowedUserIds, options = {}) {
  const {
    replyUnauthorized = true,
    unauthorizedMessage = 'Unauthorized.',
    onRejected,
  } = options;

  return async (ctx, next) => {
    const fromId = ctx.from?.id ?? ctx.chat?.id;
    if (!isAllowedTelegramUser(allowedUserIds, fromId)) {
      onRejected?.(ctx);
      // Do not leak existence of the bot beyond a short reject; never process the message.
      if (replyUnauthorized && ctx.chat?.id != null && typeof ctx.reply === 'function') {
        try {
          await ctx.reply(unauthorizedMessage);
        } catch {
          /* ignore send failures */
        }
      }
      return;
    }
    return next();
  };
}
