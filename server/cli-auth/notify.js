/**
 * Telegram (and log) alerts when CLI browser auth is required.
 */

import { createTelegramClient } from '../jobs/telegram.js';

/**
 * @param {object} opts
 * @param {string} [opts.tool]
 * @param {string} [opts.authUrl]
 * @param {string} [opts.reason]
 * @param {string} [opts.project]
 * @param {string} [opts.task]
 * @param {string} [opts.runId]
 * @param {string} [opts.queueId]
 * @param {(line: string) => void} [opts.onLog]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {boolean} [opts.dryRun]
 */
export async function notifyCliAuthRequired({
  tool = 'cursor',
  authUrl = '',
  reason = '',
  project = '',
  task = '',
  runId = '',
  queueId = '',
  onLog,
  env = process.env,
  dryRun = false,
} = {}) {
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
      : 'No login URL captured. On the VPS run: npm run auth:cursor',
    '',
    'After login: POST /api/cli-auth/retry  (or wait — the agent will re-check automatically)',
    `Or: npm run cli-auth:health`,
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
      message: reason || 'CLI session expired or missing',
      manualUrl: authUrl || 'run: npm run auth:cursor',
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
