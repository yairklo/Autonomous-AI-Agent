/**
 * Telegram (and log) alerts when CLI browser auth is required.
 */

import { createTelegramClient } from '../jobs/telegram.js';

/**
 * @param {object} opts
 */
export async function notifyCliAuthRequired({
  tool = 'cursor',
  authUrl = '',
  authCode = '',
  reason = '',
  project = '',
  task = '',
  runId = '',
  queueId = '',
  onLog,
  env = process.env,
  dryRun = false,
} = {}) {
  const cursorHint =
    tool === 'cursor'
      ? [
          'IMPORTANT: Keep this session open — the VPS login process must stay alive.',
          'Open the URL, complete Cursor login in the browser, then wait.',
          'Do NOT generate a new link until this one finishes (challenge is one-shot).',
        ]
      : [
          'Claude (Docker/SSH): open the URL, sign in, then COPY the login code from the browser.',
          'Send that code back in Telegram (or POST /api/cli-auth/submit-code {"code":"..."}).',
        ];

  const lines = [
    'CLI authentication required',
    `Tool: ${tool}`,
    reason ? `Reason: ${reason}` : '',
    runId ? `Run: ${runId}` : '',
    queueId ? `Queue: ${queueId}` : '',
    project ? `Project: ${project}` : '',
    task ? `Task: ${String(task).slice(0, 200)}` : '',
    '',
    authUrl
      ? `Open this login URL on your phone/PC:\n${authUrl}`
      : `No login URL captured. On the VPS run: npm run auth:${tool === 'claude' ? 'claude' : 'cursor'}`,
    authCode ? `CLI-printed code (if any): ${authCode}` : '',
    '',
    ...cursorHint,
    '',
    'After success the agent re-checks automatically. Optional: POST /api/cli-auth/retry',
  ].filter(Boolean);

  const text = lines.join('\n');
  onLog?.(`[cli-auth] notify:\n${text}`);

  const botToken = String(env.TELEGRAM_BOT_TOKEN || '').trim();
  const chatId = String(env.TELEGRAM_CHAT_ID || '').trim();
  if (!botToken || !chatId) {
    onLog?.(
      '[cli-auth] TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not set — alert logged only'
    );
    return { ok: true, delivered: false, text };
  }

  const tg = createTelegramClient({ botToken, chatId });
  const result = await tg.sendManualActionAlert(
    {
      id: queueId || runId || 'cli-auth',
      formUrl: authUrl || undefined,
      groupName: 'cli-auth',
    },
    {
      ats: tool,
      step: 'cli_login',
      code: 'CLI_AUTH_REQUIRED',
      message:
        (reason || 'CLI session expired or missing') +
        (authCode ? ` | code=${authCode}` : ''),
      manualUrl: authUrl || `run: npm run auth:${tool}`,
    },
    { dryRun }
  );

  return {
    ok: true,
    delivered: !result.dryRun,
    dryRun: Boolean(result.dryRun),
    text: result.text || text,
    messageId: result.messageId,
  };
}
