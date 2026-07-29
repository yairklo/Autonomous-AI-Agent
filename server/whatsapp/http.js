/**
 * WhatsApp session HTTP control plane (non-blocking).
 *
 * GET  /api/whatsapp/status
 * GET  /api/whatsapp/qr
 * POST /api/whatsapp/start
 * POST /api/whatsapp/stop
 */

import { getSharedWhatsappSession } from './session.js';
import { createTelegramClient } from '../jobs/telegram.js';

async function notifyQrViaTelegram({ qr, at }) {
  const botToken = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
  const chatId = String(process.env.TELEGRAM_CHAT_ID || '').trim();
  if (!botToken || !chatId) return { delivered: false };
  const tg = createTelegramClient({ botToken, chatId });
  if (!tg.configured) return { delivered: false };
  const text = [
    'WhatsApp QR required',
    `At: ${at || new Date().toISOString()}`,
    '',
    'Open GET /api/whatsapp/qr on the voice-agent, or scan the QR printed in server logs.',
    'Raw QR payload (first 200 chars):',
    String(qr || '').slice(0, 200),
  ].join('\n');
  await tg.sendManualActionAlert(
    { id: 'whatsapp-qr', formUrl: '', groupName: 'whatsapp' },
    {
      ats: 'whatsapp',
      step: 'qr_scan',
      code: 'WA_QR_REQUIRED',
      message: text,
      manualUrl: 'GET /api/whatsapp/qr',
    }
  );
  return { delivered: true };
}

/**
 * @param {import('express').Express} app
 * @param {{ session?: ReturnType<typeof getSharedWhatsappSession> }} [deps]
 */
export function mountWhatsappRoutes(app, deps = {}) {
  const session =
    deps.session ||
    getSharedWhatsappSession({
      notifyQr: (payload) => notifyQrViaTelegram(payload),
    });

  app.get('/api/whatsapp/status', (_req, res) => {
    res.json({ ok: true, ...session.snapshot() });
  });

  app.get('/api/whatsapp/qr', async (_req, res) => {
    const qr = session.getQr();
    if (!qr) {
      return res.status(404).json({
        ok: false,
        error: 'No QR available',
        state: session.getState(),
      });
    }
    let dataUrl = null;
    try {
      const QRCode = (await import('qrcode')).default;
      dataUrl = await QRCode.toDataURL(qr.qr, {
        width: 280,
        margin: 2,
        errorCorrectionLevel: 'M',
      });
    } catch (err) {
      console.warn('[whatsapp] qr dataUrl failed:', err.message);
    }
    return res.json({ ok: true, ...qr, dataUrl });
  });

  app.post('/api/whatsapp/start', async (_req, res) => {
    try {
      const snap = await session.start();
      res.json({ ok: true, ...snap });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err.message,
        code: err.code || 'WA_START_FAILED',
        ...session.snapshot(),
      });
    }
  });

  app.post('/api/whatsapp/stop', async (_req, res) => {
    try {
      const snap = await session.stop();
      res.json({ ok: true, ...snap });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err.message,
        ...session.snapshot(),
      });
    }
  });

  app.post('/api/whatsapp/reset', async (_req, res) => {
    try {
      if (typeof session.reset !== 'function') {
        throw new Error('reset not implemented on session');
      }
      const snap = await session.reset();
      res.json({ ok: true, ...snap });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err.message,
        ...session.snapshot(),
      });
    }
  });
}

/**
 * Optional background start after HTTP listen (never awaited by boot).
 */
export function maybeAutostartWhatsapp(session) {
  if (String(process.env.WHATSAPP_AUTOSTART || '').trim() !== '1') {
    return;
  }
  const s = session || getSharedWhatsappSession();
  void s.start().catch((err) => {
    console.warn('[whatsapp] autostart failed:', err.message);
  });
}
