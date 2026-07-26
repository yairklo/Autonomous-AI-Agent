import { Telegraf } from 'telegraf';
import { createAuthMiddleware } from './auth.js';
import { JoinUpCursorExecutor } from './executor.js';
import { JoinUpProductAgent } from './product-agent.js';
import {
  JOINUP_UNAUTHORIZED_MESSAGE,
  JOINUP_WELCOME_MESSAGE,
} from './prompt.js';
import { JoinUpSessionStore } from './session-store.js';

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

  const bot = new Telegraf(config.botToken, deps.telegrafOptions);

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

    const typing = setInterval(() => {
      ctx.sendChatAction('typing').catch(() => {});
    }, 4000);
    ctx.sendChatAction('typing').catch(() => {});

    try {
      const result = await agent.handleMessage({ userId, text });
      await ctx.reply(result.reply.slice(0, 4000));
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

  await bot.launch();
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
