/**
 * Long-polls Telegram getUpdates for job_approve:<id>/job_reject:<id> button
 * taps sent by telegram.js:sendJobApprovalRequest, and resolves them.
 *
 * Without this, the Approve/Reject buttons are well-formed but nothing ever
 * receives the callback_query Telegram sends when a human taps them — see
 * data/jobs-pipeline.README.md and the architecture review that found this
 * gap. This is the piece that makes the human approval gate real.
 *
 * On Approve, this also triggers the actual Playwright submission
 * (submitApprovedJob) — "done" per the original spec means the human tap
 * itself causes the form fill, not a second manual step.
 *
 * Only one poller should run per bot token: Telegram serializes getUpdates
 * per token and a second concurrent long-poller gets 409 Conflict.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config as appConfig } from '../config.js';
import { createTelegramClient } from './telegram.js';
import { loadJobsConfig } from './jobs-config.js';
import { resolveJobApproval, submitApprovedJob } from './pipeline.js';

const OFFSET_PATH = path.join(appConfig.root, 'data', 'telegram-update-offset.json');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readOffsetState() {
  try {
    const raw = JSON.parse(fs.readFileSync(OFFSET_PATH, 'utf8'));
    return { offset: Number(raw.offset) || 0, primed: Boolean(raw.primed), exists: true };
  } catch {
    return { offset: 0, primed: false, exists: false };
  }
}

function writeOffsetState(offset, primed) {
  try {
    fs.mkdirSync(path.dirname(OFFSET_PATH), { recursive: true });
    fs.writeFileSync(
      OFFSET_PATH,
      JSON.stringify({ offset, primed, updatedAt: new Date().toISOString() }, null, 2),
      'utf8'
    );
  } catch {
    /* best-effort — a lost offset just re-delivers a batch of updates once */
  }
}

let running = false;

/**
 * @param {{ configPath?: string, onLog?: (line: string) => void }} [opts]
 * @returns {{ stop: () => void }}
 */
export function startTelegramApprovalPolling({ configPath, onLog = () => {} } = {}) {
  if (running) {
    onLog('[telegram-poll] already running — skip');
    return { stop: () => {} };
  }

  let jobsConfig;
  try {
    jobsConfig = loadJobsConfig(configPath);
  } catch (err) {
    onLog(`[telegram-poll] config load failed, not starting: ${err.message}`);
    return { stop: () => {} };
  }

  if (!jobsConfig.telegram.enabled || !jobsConfig.telegram.botToken) {
    onLog(
      '[telegram-poll] TELEGRAM_BOT_TOKEN not set — Approve/Reject buttons will be sent but not actionable'
    );
    return { stop: () => {} };
  }

  const telegram = createTelegramClient({
    botToken: jobsConfig.telegram.botToken,
    chatId: jobsConfig.telegram.chatId,
  });

  running = true;
  let stopRequested = false;
  let { offset, primed } = readOffsetState();

  async function handleCallback(cq) {
    const parsed = telegram.parseApprovalCallback(cq.data);
    if (!parsed) return;
    onLog(
      `[telegram-poll] callback action=${parsed.action} jobId=${parsed.jobId} from=${cq.from?.username || cq.from?.id || 'unknown'}`
    );
    try {
      const { job, action } = resolveJobApproval({
        configPath,
        callbackData: cq.data,
        onLog,
      });

      await telegram.answerCallbackQuery(cq.id, {
        text: action === 'approve' ? 'Approved — submitting…' : 'Rejected',
      });
      await telegram.editMessageAfterDecision(cq.message?.message_id, {
        originalText: cq.message?.text,
        statusLine:
          action === 'approve'
            ? `✅ Approved by ${cq.from?.username || cq.from?.first_name || 'you'} — submitting via Playwright…`
            : `❌ Rejected by ${cq.from?.username || cq.from?.first_name || 'you'}`,
      });

      if (action === 'approve') {
        submitApprovedJob({ configPath, jobId: job.id, onLog }).catch((err) => {
          onLog(`[telegram-poll] auto-submit after approve failed job=${job.id}: ${err.message}`);
        });
      }
    } catch (err) {
      onLog(`[telegram-poll] resolve failed jobId=${parsed.jobId}: ${err.message}`);
      await telegram
        .answerCallbackQuery(cq.id, { text: `Error: ${err.message}`.slice(0, 200), showAlert: true })
        .catch(() => {});
    }
  }

  async function primeOffsetIfFirstRun() {
    if (primed) return;
    // First activation ever: skip whatever backlog already sits in Telegram's
    // queue (e.g. taps on job alerts sent before this poller existed) instead
    // of firing real, unattended Playwright submissions for stale approvals.
    try {
      const backlog = await telegram.getUpdates({ offset, timeoutSec: 0 });
      if (backlog.length) {
        offset = backlog[backlog.length - 1].update_id + 1;
        onLog(
          `[telegram-poll] first run — skipping ${backlog.length} pre-existing update(s), starting from offset=${offset}`
        );
      }
    } catch (err) {
      onLog(`[telegram-poll] priming fetch failed (will retry in main loop): ${err.message}`);
      return; // don't mark primed; retry priming behavior next tick is fine since offset unchanged
    }
    primed = true;
    writeOffsetState(offset, primed);
  }

  async function loop() {
    await primeOffsetIfFirstRun();
    onLog(`[telegram-poll] started (offset=${offset})`);
    while (!stopRequested) {
      let updates = [];
      try {
        updates = await telegram.getUpdates({ offset, timeoutSec: 25 });
      } catch (err) {
        onLog(`[telegram-poll] getUpdates error: ${err.message}`);
        await sleep(5000);
        continue;
      }
      for (const update of updates) {
        offset = update.update_id + 1;
        if (update.callback_query) {
          await handleCallback(update.callback_query);
        }
      }
      if (updates.length) writeOffsetState(offset, true);
    }
    running = false;
    onLog('[telegram-poll] stopped');
  }

  void loop();

  return {
    stop: () => {
      stopRequested = true;
    },
  };
}
