import { Telegraf } from 'telegraf';
import { createAuthMiddleware } from './auth.js';
import {
  JOINUP_UNAUTHORIZED_MESSAGE,
  JOINUP_WELCOME_MESSAGE,
} from './prompt.js';
import {
  bridgeActivity,
  telegramActivityId,
  telegramActorLabel,
} from './activity-bridge.js';
import {
  clientIdForTelegramUser,
  joinupChat,
  joinupDispatch,
  joinupPollRun,
  joinupRedeployStaging,
  joinupReset,
} from './voice-agent-client.js';
import { resolveVoiceAgentBaseUrl } from './voice-agent-url.js';
import {
  extractAuthCode,
  looksLikeAuthCodeMessage,
} from '../cli-auth/parse-auth-url.js';

/**
 * Submit Claude browser login code to voice-agent.
 */
async function submitAuthCodeToVoiceAgent(code) {
  const base = resolveVoiceAgentBaseUrl().replace(/\/$/, '');
  const res = await fetch(`${base}/api/cli-auth/submit-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || data.message || `submit-code HTTP ${res.status}`);
    err.data = data;
    throw err;
  }
  return data;
}

/**
 * Thin joinUp Telegram bot: Telegram I/O + allow-list only.
 * Grill / Cursor / JoinUp dispatch run on voice-agent via /api/joinup/*.
 *
 * @param {object} config - from loadJoinUpTelegramConfig()
 * @param {{ onLog?: (line: string) => void, telegrafOptions?: object }} [deps]
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
  const voiceUrl = resolveVoiceAgentBaseUrl();
  onLog(`[joinup-telegram] thin bot → voice-agent ${voiceUrl}`);

  const handlerTimeout = Number(
    process.env.JOINUP_TELEGRAM_HANDLER_TIMEOUT_MS || 3_600_000
  );
  const bot = new Telegraf(config.botToken, {
    handlerTimeout: Number.isFinite(handlerTimeout) ? handlerTimeout : 3_600_000,
    ...(deps.telegrafOptions || {}),
  });

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
    try {
      await joinupReset({ userId: ctx.from.id });
    } catch (err) {
      onLog(`[joinup-telegram] reset on /start failed: ${err.message}`);
    }
    await ctx.reply(JOINUP_WELCOME_MESSAGE);
  });

  bot.command('help', async (ctx) => {
    await ctx.reply(
      [
        'joinUp Product Agent commands:',
        '/start — welcome + how this works',
        '/reset — clear our conversation and start over',
        '/redeploy_staging — redeploy joinUp API staging on Render + health check',
        '/authcode <code> — paste Claude browser login code to the VPS CLI',
        '/help — this message',
        '',
        'Otherwise just describe the joinUp change you want in plain language.',
        'I will ask product/UX questions, summarize, and build only after you confirm.',
        '',
        `Brain: voice-agent at ${voiceUrl}`,
      ].join('\n')
    );
  });

  bot.command('authcode', async (ctx) => {
    const raw = String(ctx.message?.text || '').replace(/^\/authcode\s*/i, '');
    const code = extractAuthCode(raw) || raw.trim();
    if (!code) {
      await ctx.reply('שימוש: /authcode YOUR_CODE');
      return;
    }
    try {
      const result = await submitAuthCodeToVoiceAgent(code);
      await ctx.reply(
        result.ok || result.claude?.ok
          ? 'קוד התקבל — Claude מחובר (או בתהליך סיום). נסה שוב את ההודעה הקודמת.'
          : `נשלח לשרת: ${result.message || 'ממתין'} — אם צריך קוד נוסף, שלח שוב.`
      );
    } catch (err) {
      onLog(`[joinup-telegram] authcode failed: ${err.message}`);
      await ctx.reply(`שליחת הקוד נכשלה: ${err.message}`);
    }
  });

  bot.command('reset', async (ctx) => {
    try {
      await joinupReset({ userId: ctx.from.id });
      await ctx.reply(
        'Okay — I cleared our conversation. Tell me a new joinUp idea whenever you are ready.'
      );
    } catch (err) {
      onLog(`[joinup-telegram] reset error: ${err.message}`);
      await ctx.reply(`Reset failed: ${err.message}`);
    }
  });

  bot.command('redeploy_staging', async (ctx) => {
    const userId = ctx.from.id;
    await ctx.reply('מפעיל רידיפלוי ל-staging ב-Render ועוקב אחרי בריאות השרת…');
    void bridgeActivity({
      activityId: telegramActivityId(userId),
      kind: 'status',
      source: 'joinup-telegram',
      platform: 'telegram',
      actorId: String(userId),
      actorLabel: telegramActorLabel(userId),
      title: 'Redeploy staging (Telegram)',
      text: '/redeploy_staging',
    });

    const typing = setInterval(() => {
      ctx.sendChatAction('typing').catch(() => {});
    }, 4000);
    try {
      const result = await joinupRedeployStaging({ force: true });
      await ctx.reply(
        ['רידיפלוי staging:', result.text || JSON.stringify(result.staging || {})]
          .join('\n')
          .slice(0, 4000)
      );
      void bridgeActivity({
        activityId: telegramActivityId(userId),
        kind: result.ok ? 'run_end' : 'error',
        source: 'joinup-telegram',
        platform: 'telegram',
        actorId: String(userId),
        actorLabel: telegramActorLabel(userId),
        title: 'Redeploy staging (Telegram)',
        text: result.text || '',
        meta: { ok: result.ok },
      });
    } catch (err) {
      onLog(`[joinup-telegram] redeploy_staging error: ${err.message}`);
      await ctx.reply(`רידיפלוי נכשל: ${err.message}`);
    } finally {
      clearInterval(typing);
    }
  });

  bot.on('message', async (ctx) => {
    if (ctx.message?.text?.startsWith('/')) return;

    if (!ctx.message?.text) {
      await ctx.reply('Please send a text message describing your joinUp idea.');
      return;
    }

    const userId = ctx.from.id;
    const text = ctx.message.text;

    // Claude browser login code → paste into waiting VPS `claude login` process.
    if (looksLikeAuthCodeMessage(text)) {
      const code =
        extractAuthCode(text.replace(/^\/authcode\s*/i, '')) || text.trim();
      onLog(`[joinup-telegram] auth code from=${userId}`);
      try {
        const result = await submitAuthCodeToVoiceAgent(code);
        await ctx.reply(
          result.ok || result.claude?.ok
            ? 'קיבלתי את קוד ההתחברות ל-Claude. אפשר להמשיך — שלח שוב את הבקשה.'
            : `${result.message || 'הקוד נשלח לשרת.'}\nאם עדיין לא מחובר, שלח קוד חדש מהדפדפן.`
        );
      } catch (err) {
        await ctx.reply(`לא הצלחתי להעביר את הקוד לשרת: ${err.message}`);
      }
      return;
    }

    onLog(`[joinup-telegram] message from=${userId} chars=${text.length}`);

    void bridgeActivity({
      activityId: telegramActivityId(userId),
      kind: 'chat_user',
      source: 'joinup-telegram',
      platform: 'telegram',
      actorId: String(userId),
      actorLabel: telegramActorLabel(userId),
      title: 'joinUp Telegram',
      text,
    });

    const typing = setInterval(() => {
      ctx.sendChatAction('typing').catch(() => {});
    }, 4000);
    ctx.sendChatAction('typing').catch(() => {});

    try {
      const chat = await joinupChat({ userId, text });
      if (chat.reply) {
        await ctx.reply(String(chat.reply).slice(0, 4000));
        void bridgeActivity({
          activityId: telegramActivityId(userId),
          kind: 'chat_assistant',
          source: 'joinup-telegram',
          platform: 'telegram',
          actorId: String(userId),
          actorLabel: telegramActorLabel(userId),
          title: 'joinUp Telegram',
          text: String(chat.reply).slice(0, 2000),
          meta: { phase: chat.phase, clientId: clientIdForTelegramUser(userId) },
        });
      }

      if (!chat.needsDispatch) return;

      // Async build: ack immediately, poll voice-agent until done.
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
        text: 'User confirmed — Cursor dispatch starting on voice-agent',
      });

      const started = await joinupDispatch({ userId });
      const runId = started.runId;
      onLog(`[joinup-telegram] dispatch accepted runId=${runId}`);

      const final = await joinupPollRun(runId, {
        onTick: () => {
          ctx.sendChatAction('typing').catch(() => {});
        },
      });

      const completion =
        final.result ||
        (final.status === 'completed'
          ? 'Build finished.'
          : `Build failed: ${final.error || 'unknown error'}`);
      await ctx.reply(String(completion).slice(0, 4000));
      void bridgeActivity({
        activityId: telegramActivityId(userId),
        kind: final.status === 'completed' ? 'run_end' : 'error',
        source: 'joinup-telegram',
        platform: 'telegram',
        actorId: String(userId),
        actorLabel: telegramActorLabel(userId),
        title: 'joinUp build finished',
        text: String(completion).slice(0, 2000),
        meta: {
          runId,
          status: final.status,
          vercelUrl: final.vercelUrl || '',
          stagingUrl: final.stagingUrl || '',
        },
      });
    } catch (err) {
      onLog(`[joinup-telegram] handler error: ${err.message}`);
      if (err.code === 'CLI_AUTH_REQUIRED' || err.code === 'CLI_AUTH_TIMEOUT') {
        const tool = err.tool || 'claude';
        const url = err.authUrl || '';
        const lines =
          tool === 'cursor'
            ? [
                'צריך להתחבר ל-Cursor על השרת.',
                url
                  ? `פתח את הקישור (אותו קישור — לא לבקש חדש):\n${url}`
                  : 'בשרת: npm run auth:cursor',
                '',
                'חשוב: תהליך ה-login על ה-VPS חייב להישאר פתוח. אחרי אישור בדפדפן חכה שהסוכן יזהה — אל תיצור קישור חדש.',
              ]
            : [
                'צריך להתחבר ל-Claude על השרת.',
                url
                  ? `פתח את הקישור בדפדפן:\n${url}`
                  : 'בשרת: npm run auth:claude',
                '',
                'אחרי ההתחברות בדפדפן יופיע קוד — העתק אותו ושלח אותו כאן כהודעה (או /authcode הקוד).',
              ];
        await ctx.reply(lines.join('\n').slice(0, 4000));
      } else {
        await ctx.reply(
          'Sorry — I hit a temporary issue talking to the voice-agent. Please try again in a moment.'
        );
      }
    } finally {
      clearInterval(typing);
    }
  });

  return { bot };
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

  onLog('[joinup-telegram] connecting to Telegram…');
  bot.botInfo = await bot.telegram.getMe();
  onLog(`[joinup-telegram] authenticated as @${bot.botInfo.username}`);

  void bot
    .launch({ dropPendingUpdates: false })
    .catch((err) => {
      onLog(`[joinup-telegram] launch error: ${err.message}`);
    });

  onLog('[joinup-telegram] bot launched (long polling, thin → voice-agent)');

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
