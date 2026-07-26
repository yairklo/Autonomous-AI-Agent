import { Telegraf } from 'telegraf';
import { createAuthMiddleware } from './auth.js';
import { JoinUpCursorExecutor } from './executor.js';
import { JoinUpProductAgent } from './product-agent.js';
import {
  JOINUP_UNAUTHORIZED_MESSAGE,
  JOINUP_WELCOME_MESSAGE,
} from './prompt.js';
import { isExplicitConfirmation, JoinUpSessionStore } from './session-store.js';
import {
  bridgeActivity,
  telegramActivityId,
  telegramActorLabel,
} from './activity-bridge.js';

/**
 * Create the joinUp Telegram bot (Telegraf) with auth + product grilling workflow.
 *
 * @param {object} config - from loadJoinUpTelegramConfig()
 * @param {{
 *   agent?: JoinUpProductAgent,
 *   executor?: JoinUpCursorExecutor,
 *   store?: JoinUpSessionStore,
 *   onLog?: (line: string) => void,
 *   telegrafOptions?: object,
 * }} [deps]
 */
export function createJoinUpTelegramBot(config, deps = {}) {
  if (!config?.botToken) {
    const err = new Error(
      'JOINUP_TELEGRAM_BOT_TOKEN is not set. Add it to your .env file.'
    );
    err.code = 'JOINUP_TELEGRAM_NOT_CONFIGURED';
    throw err;
  }
  if (!config.allowedUserIds || config.allowedUserIds.size === 0) {
    const err = new Error(
      'ALLOWED_TELEGRAM_USER_IDS is empty. Add comma-separated Telegram user IDs to .env.'
    );
    err.code = 'JOINUP_TELEGRAM_NO_ALLOWLIST';
    throw err;
  }

  const onLog = deps.onLog || ((line) => console.log(line));
  const store =
    deps.store ||
    new JoinUpSessionStore({ stateFile: config.stateFile });
  const executor =
    deps.executor ||
    new JoinUpCursorExecutor({ joinUpRoot: config.joinUpRoot });
  const agent =
    deps.agent ||
    new JoinUpProductAgent({
      store,
      executor,
      mock: config.mock,
      sessionsFile: config.sessionsFile,
      claudeBin: config.claudeBin,
      onLog,
    });

  // Cursor builds take far longer than Telegraf's default 90s handlerTimeout
  // (p-timeout kills the whole bot process on expiry — silent log loss).
  const handlerTimeout = Number(
    process.env.JOINUP_TELEGRAM_HANDLER_TIMEOUT_MS || 3_600_000
  );
  const bot = new Telegraf(config.botToken, {
    handlerTimeout: Number.isFinite(handlerTimeout) ? handlerTimeout : 3_600_000,
    ...(deps.telegrafOptions || {}),
  });

  // Authorization: reject anyone not in ALLOWED_TELEGRAM_USER_IDS.
  bot.use(
    createAuthMiddleware(config.allowedUserIds, {
      replyUnauthorized: true,
      unauthorizedMessage: JOINUP_UNAUTHORIZED_MESSAGE,
      onRejected: (ctx) => {
        onLog(
          `[joinup-telegram] rejected unauthorized user id=${ctx.from?.id ?? 'unknown'}`
        );
      },
    })
  );

  bot.start(async (ctx) => {
    store.update(ctx.from.id, { phase: 'idle' });
    await ctx.reply(JOINUP_WELCOME_MESSAGE);
  });

  bot.command('help', async (ctx) => {
    await ctx.reply(
      [
        'joinUp Product Agent commands:',
        '/start — welcome + how this works',
        '/reset — clear our conversation and start over',
        '/help — this message',
        '',
        'Otherwise just describe the joinUp change you want in plain language.',
        'I will ask product/UX questions, summarize, and build only after you confirm.',
      ].join('\n')
    );
  });

  bot.command('reset', async (ctx) => {
    const result = await agent.handleMessage({
      userId: ctx.from.id,
      text: 'reset',
    });
    await ctx.reply(result.reply);
  });

  bot.on('message', async (ctx) => {
    // Commands (/start, /help, /reset) are handled above; skip if already consumed.
    if (ctx.message?.text?.startsWith('/')) return;

    if (!ctx.message?.text) {
      await ctx.reply('Please send a text message describing your joinUp idea.');
      return;
    }

    const userId = ctx.from.id;
    const text = ctx.message.text;
    onLog(`[joinup-telegram] message from=${userId} chars=${text.length}`);

    const session = store.get(userId);
    const startingBuild =
      Boolean(session?.pendingTechnicalPrompt) && isExplicitConfirmation(text);

    void bridgeActivity({
      activityId: telegramActivityId(userId),
      kind: 'chat_user',
      source: 'joinup-telegram',
      platform: 'telegram',
      actorId: String(userId),
      actorLabel: telegramActorLabel(userId),
      title: 'joinUp Telegram',
      text,
      project: config.joinUpRoot,
    });

    // Acknowledge immediately so Telegraf isn't left hanging on a multi-hour Cursor run.
    // Do NOT stream Cursor progress into Telegram — live logs are host-only (GUI).
    if (startingBuild) {
      await ctx.reply(
        'מתחיל לבנות ב-joinUp. אעדכן כאן כשזה מוכן, עם קישור לבילד.'
      );
      void bridgeActivity({
        activityId: telegramActivityId(userId),
        kind: 'status',
        source: 'joinup-telegram',
        platform: 'telegram',
        actorId: String(userId),
        actorLabel: telegramActorLabel(userId),
        title: 'joinUp build confirmed',
        text: 'User confirmed — Cursor dispatch starting',
        project: config.joinUpRoot,
      });
    }

    const typing = setInterval(() => {
      ctx.sendChatAction('typing').catch(() => {});
    }, 4000);
    ctx.sendChatAction('typing').catch(() => {});

    try {
      const result = await agent.handleMessage({ userId, text });
      if (result?.reply) {
        await ctx.reply(result.reply.slice(0, 4000));
        void bridgeActivity({
          activityId: telegramActivityId(userId),
          kind: result.dispatched ? 'run_end' : 'chat_assistant',
          source: 'joinup-telegram',
          platform: 'telegram',
          actorId: String(userId),
          actorLabel: telegramActorLabel(userId),
          title: result.dispatched ? 'joinUp build finished' : 'joinUp Telegram',
          text: result.reply.slice(0, 2000),
          project: config.joinUpRoot,
          meta: {
            phase: result.phase,
            vercelUrl: result.vercelUrl || '',
            stagingUrl: result.stagingUrl || '',
          },
        });
      }
    } catch (err) {
      onLog(`[joinup-telegram] handler error: ${err.message}`);
      await ctx.reply(
        'Sorry — I hit a temporary issue. Please try again in a moment.'
      );
    } finally {
      clearInterval(typing);
    }
  });

  return { bot, agent, executor, store };
}

/**
 * Launch long-polling. Returns a stop() function.
 * @param {ReturnType<typeof createJoinUpTelegramBot>} instance
 * @param {{ onLog?: (line: string) => void }} [options]
 */
export async function launchJoinUpTelegramBot(instance, options = {}) {
  const onLog = options.onLog || ((line) => console.log(line));
  const { bot } = instance;

  bot.catch((err, ctx) => {
    onLog(
      `[joinup-telegram] telegraf error update=${ctx?.update?.update_id ?? '?'} ${err.message}`
    );
  });

  // Telegraf's launch() awaits the polling loop forever — do not await it or
  // our service bootstrap (and "bot launched" logs) never complete.
  onLog('[joinup-telegram] connecting to Telegram…');
  bot.botInfo = await bot.telegram.getMe();
  onLog(`[joinup-telegram] authenticated as @${bot.botInfo.username}`);

  void bot
    .launch({ dropPendingUpdates: false })
    .catch((err) => {
      onLog(`[joinup-telegram] launch error: ${err.message}`);
    });

  onLog('[joinup-telegram] bot launched (long polling)');

  const stop = (reason = 'stop') => {
    try {
      bot.stop(reason);
      onLog(`[joinup-telegram] bot stopped (${reason})`);
    } catch (err) {
      onLog(`[joinup-telegram] stop error: ${err.message}`);
    }
  };

  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));

  return { stop };
}
