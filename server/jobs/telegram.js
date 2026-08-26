/**
 * Telegram notifier with Approve / Reject inline buttons.
 * Uses Bot HTTP API; injectable fetch for tests.
 */

function envOr(value, fallback = '') {
  return value != null && String(value).trim() ? String(value).trim() : fallback;
}

/**
 * @param {object} opts
 * @param {string} opts.botToken
 * @param {string} opts.chatId
 * @param {typeof fetch} [opts.fetchImpl]
 */
export function createTelegramClient({
  botToken,
  chatId,
  fetchImpl = globalThis.fetch,
} = {}) {
  const token = envOr(botToken);
  const chat = envOr(chatId);

  async function api(method, body) {
    if (!token) {
      const err = new Error('TELEGRAM_BOT_TOKEN is not configured');
      err.code = 'TELEGRAM_NOT_CONFIGURED';
      throw err;
    }
    if (typeof fetchImpl !== 'function') {
      const err = new Error('fetch is not available for Telegram API');
      err.code = 'TELEGRAM_NO_FETCH';
      throw err;
    }
    const url = `https://api.telegram.org/bot${token}/${method}`;
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      const err = new Error(
        data.description || `Telegram API ${method} failed (${res.status})`
      );
      err.code = 'TELEGRAM_API_ERROR';
      err.details = data;
      throw err;
    }
    return data.result;
  }

  return {
    configured: Boolean(token && chat),
    chatId: chat,

    /**
     * Send job alert with Approve / Reject buttons.
     * Callback data: job_approve:<id> / job_reject:<id>
     */
    async sendJobApprovalRequest(job, { dryRun = false } = {}) {
      const text = formatJobAlert(job);
      const replyMarkup = {
        inline_keyboard: [
          [
            {
              text: 'Approve',
              callback_data: `job_approve:${job.id}`.slice(0, 64),
            },
            {
              text: 'Reject',
              callback_data: `job_reject:${job.id}`.slice(0, 64),
            },
          ],
        ],
      };

      if (dryRun || !token || !chat) {
        return {
          ok: true,
          dryRun: true,
          messageId: `dry-${job.id}`,
          text,
          replyMarkup,
        };
      }

      const result = await api('sendMessage', {
        chat_id: chat,
        text,
        reply_markup: replyMarkup,
        disable_web_page_preview: true,
      });
      return {
        ok: true,
        dryRun: false,
        messageId: result.message_id,
        text,
        replyMarkup,
      };
    },

    async sendSuccessAlert(job, details = {}, { dryRun = false } = {}) {
      const text = [
        '✅ Application submitted',
        `Job: ${job.id}`,
        `Group: ${job.groupName || 'n/a'}`,
        `ATS: ${details.ats || 'unknown'}`,
        `Form: ${job.formUrl || 'n/a'}`,
      ].join('\n');

      if (dryRun || !token || !chat) {
        return { ok: true, dryRun: true, text };
      }
      const result = await api('sendMessage', {
        chat_id: chat,
        text,
        disable_web_page_preview: true,
      });
      return { ok: true, dryRun: false, messageId: result.message_id, text };
    },

    async sendFailureAlert(job, error, { dryRun = false } = {}) {
      const text = [
        '⚠️ Job submission failed',
        `Job: ${job.id}`,
        `Group: ${job.groupName || 'n/a'}`,
        `Error: ${error?.message || String(error)}`,
      ].join('\n');

      if (dryRun || !token || !chat) {
        return { ok: true, dryRun: true, text };
      }
      const result = await api('sendMessage', {
        chat_id: chat,
        text,
        disable_web_page_preview: true,
      });
      return { ok: true, dryRun: false, messageId: result.message_id, text };
    },

    /**
     * Immediate alert when ATS flow needs a human (login/CAPTCHA/unmapped field).
     * Includes the exact step and a manual completion link.
     */
    async sendManualActionAlert(job, details = {}, { dryRun = false } = {}) {
      const manualUrl =
        details.manualUrl ||
        details.finalUrl ||
        job.formUrl ||
        job.contacts?.urls?.[0] ||
        'n/a';
      const text = [
        '🛑 Requires Manual Action',
        `Job: ${job.id}`,
        `ATS: ${details.ats || 'unknown'}`,
        `Stopped at step: ${details.step || 'unknown'}`,
        `Code: ${details.code || 'HUMAN_INTERVENTION_REQUIRED'}`,
        `Detail: ${details.message || details.error || 'n/a'}`,
        `Screenshot: ${details.screenshotPath || 'n/a'}`,
        `Complete manually: ${manualUrl}`,
      ].join('\n');

      if (dryRun || !token || !chat) {
        return { ok: true, dryRun: true, text };
      }
      const result = await api('sendMessage', {
        chat_id: chat,
        text,
        disable_web_page_preview: true,
      });
      return { ok: true, dryRun: false, messageId: result.message_id, text };
    },

    /**
     * Long-poll for updates (used to receive Approve/Reject button taps).
     * @param {{ offset?: number, timeoutSec?: number }} [opts]
     * @returns {Promise<object[]>} raw Telegram Update objects
     */
    async getUpdates({ offset, timeoutSec = 25 } = {}) {
      if (!token) return [];
      const result = await api('getUpdates', {
        offset,
        timeout: timeoutSec,
        allowed_updates: ['callback_query'],
      });
      return Array.isArray(result) ? result : [];
    },

    /**
     * Stop the button's loading spinner and optionally toast a message.
     */
    async answerCallbackQuery(callbackQueryId, { text, showAlert = false } = {}) {
      if (!token) return { ok: true, dryRun: true };
      try {
        await api('answerCallbackQuery', {
          callback_query_id: callbackQueryId,
          text,
          show_alert: showAlert,
        });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },

    /**
     * Replace the Approve/Reject keyboard with a plain status line once resolved,
     * so re-tapping an already-handled message can't fire a second action.
     */
    async editMessageAfterDecision(messageId, { originalText, statusLine } = {}) {
      if (!token || !chat || !messageId) return { ok: true, dryRun: true };
      try {
        await api('editMessageText', {
          chat_id: chat,
          message_id: messageId,
          text: [originalText, '', statusLine].filter(Boolean).join('\n'),
          disable_web_page_preview: true,
        });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },

    /**
     * Parse Telegram callback_data into { action, jobId }.
     */
    parseApprovalCallback(callbackData) {
      const raw = String(callbackData || '');
      const m = raw.match(/^job_(approve|reject):(.+)$/);
      if (!m) return null;
      return { action: m[1], jobId: m[2] };
    },

    async sendPhotoPng(pngBuffer, caption, { dryRun = false } = {}) {
      if (dryRun || !token || !chat) {
        return { ok: true, dryRun: true, caption };
      }
      const form = new FormData();
      form.append('chat_id', chat);
      form.append('caption', String(caption || '').slice(0, 1024));
      form.append(
        'photo',
        new Blob([pngBuffer], { type: 'image/png' }),
        'whatsapp-qr.png'
      );
      const url = `https://api.telegram.org/bot${token}/sendPhoto`;
      const res = await fetchImpl(url, { method: 'POST', body: form });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) {
        const err = new Error(
          data.description || `Telegram API sendPhoto failed (${res.status})`
        );
        err.code = 'TELEGRAM_API_ERROR';
        throw err;
      }
      return { ok: true, dryRun: false, messageId: data.result?.message_id };
    },
  };
}

function formatJobAlert(job) {
  const roles = (job.rolesMatched || []).join(', ') || 'Full Stack/Backend';
  const url = job.formUrl || job.contacts?.urls?.[0] || 'n/a';
  return [
    '🎯 New job match (approval required)',
    `ID: ${job.id}`,
    `Group: ${job.groupName || 'n/a'}`,
    `Author: ${job.author || 'n/a'}`,
    `Roles: ${roles}`,
    `Form: ${url}`,
    '',
    (job.snippet || job.text || '').slice(0, 500),
    '',
    'Approve → Playwright form submit | Reject → skip',
    'Safety: never WhatsApp group send; never submit without Approve.',
  ].join('\n');
}
