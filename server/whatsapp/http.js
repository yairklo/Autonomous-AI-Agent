/**
 * WhatsApp session HTTP control plane (non-blocking).
 *
 * GET  /api/whatsapp/status
 * GET  /api/whatsapp/qr
 * GET  /api/whatsapp/groups
 * GET  /api/whatsapp/ingest-coverage
 * GET  /api/whatsapp/messages
 * POST /api/whatsapp/start
 * POST /api/whatsapp/stop
 */

import { getSharedWhatsappSession } from './session.js';
import { listJoinedWhatsappGroups } from './groups.js';
import { createTelegramClient } from '../jobs/telegram.js';
import { isAllowedGroup, loadJobsConfig } from '../jobs/jobs-config.js';
import { isTrackedGroupName, mongoReady } from '../jobs-engine/group-store.js';
import { listCapturedChatStats } from '../jobs-engine/ingest-coverage.js';
import { listRecentWhatsappMessages } from '../jobs-engine/job-store.js';

function errText(err) {
  if (err == null) return 'unknown';
  if (typeof err === 'string') return err;
  const msg = String(err.message || err.originalMessage || '').trim();
  if (msg) return err.code ? `${msg} (${err.code})` : msg;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

async function notifyQrViaTelegram({ qr, at }) {
  const botToken = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
  const chatId = String(process.env.TELEGRAM_CHAT_ID || '').trim();
  if (!botToken || !chatId) return { delivered: false };
  const tg = createTelegramClient({ botToken, chatId });
  if (!tg.configured) return { delivered: false };
  const caption = [
    'WhatsApp QR required — scan with Linked devices',
    `At: ${at || new Date().toISOString()}`,
    'Also: GET /api/whatsapp/qr',
  ].join('\n');
  try {
    const QRCode = (await import('qrcode')).default;
    const png = await QRCode.toBuffer(qr, {
      width: 280,
      margin: 2,
      errorCorrectionLevel: 'M',
      type: 'png',
    });
    await tg.sendPhotoPng(png, caption);
    return { delivered: true, image: true };
  } catch (err) {
    await tg.sendManualActionAlert(
      { id: 'whatsapp-qr', formUrl: '', groupName: 'whatsapp' },
      {
        ats: 'whatsapp',
        step: 'qr_scan',
        code: 'WA_QR_REQUIRED',
        message: `${caption}\n(QR image failed: ${err.message})`,
        manualUrl: 'GET /api/whatsapp/qr',
      }
    );
    return { delivered: true, image: false };
  }
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

  app.get('/api/whatsapp/groups', async (_req, res) => {
    const snap = session.snapshot();
    const client = session.getClient?.();
    if (!client || snap.state !== 'authenticated') {
      return res.status(409).json({
        ok: false,
        error: 'WhatsApp is not connected',
        code: 'WA_NOT_READY',
        state: snap.state,
      });
    }
    try {
      const jobsConfig = loadJobsConfig();
      const joined = await listJoinedWhatsappGroups(client);
      const groups = [];
      for (const g of joined) {
        let tracked = false;
        if (mongoReady()) {
          try {
            tracked = await isTrackedGroupName(g.name);
          } catch {
            tracked = false;
          }
        }
        const allowListed = isAllowedGroup(g.name, jobsConfig);
        groups.push({
          ...g,
          tracked: Boolean(tracked || allowListed),
          allowListed,
        });
      }
      const readOnlyCount = groups.filter((g) => g.isReadOnly).length;
      const trackedCount = groups.filter((g) => g.tracked).length;
      return res.json({
        ok: true,
        count: groups.length,
        trackedCount,
        readOnlyCount,
        newsletterCount: groups.filter((g) => g.isNewsletter).length,
        note: 'Raw ingest captures all group/newsletter chats. Job matching uses tracked/allow-list names.',
        groups,
      });
    } catch (err) {
      console.error('[whatsapp] GET /groups failed:', err);
      return res.status(500).json({
        ok: false,
        error: errText(err),
        code: err.code || 'WA_GROUPS_FAILED',
        state: snap.state,
      });
    }
  });

  app.get('/api/whatsapp/ingest-coverage', async (req, res) => {
    if (!mongoReady()) {
      return res.status(503).json({
        ok: false,
        error: 'MongoDB is not connected',
        code: 'MONGO_UNAVAILABLE',
      });
    }
    try {
      const since = req.query.since ? String(req.query.since) : undefined;
      const captured = await listCapturedChatStats({ since });
      return res.json({
        ok: true,
        chatCount: captured.length,
        messageCount: captured.reduce((n, c) => n + c.count, 0),
        since: since || null,
        chats: captured,
      });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: err.message,
        code: err.code || 'WA_COVERAGE_FAILED',
      });
    }
  });

  app.get('/api/whatsapp/messages', async (req, res) => {
    if (!mongoReady()) {
      return res.status(503).json({
        ok: false,
        error: 'MongoDB is not connected',
        code: 'MONGO_UNAVAILABLE',
      });
    }
    try {
      const messages = await listRecentWhatsappMessages({
        limit: req.query.limit,
        chatId: req.query.chatId,
        since: req.query.since,
      });
      const { explainMessageMatch } = await import('../jobs-engine/match-explain.js');
      const { whatsappSelfUserId } = await import('../jobs-engine/chat-cache.js');
      const jobsConfig = loadJobsConfig();
      const selfUser = whatsappSelfUserId(session.getClient?.());
      const trackedNames = [...(jobsConfig.whatsapp?.groups || [])];
      for (const [jid, name] of Object.entries(jobsConfig.whatsapp?.groupJids || {})) {
        if (jid) trackedNames.push(jid);
        if (name) trackedNames.push(name);
      }
      if (mongoReady()) {
        try {
          const { listTrackedGroups } = await import('../jobs-engine/group-store.js');
          const tracked = await listTrackedGroups({ activeOnly: true });
          for (const g of tracked) {
            if (g.name) trackedNames.push(g.name);
            if (g.jid) trackedNames.push(g.jid);
            if (g.groupId && String(g.groupId).includes('@')) trackedNames.push(g.groupId);
          }
        } catch {
          /* file allow-list is enough */
        }
      }
      const explained = messages.map((m) => ({
        ...m,
        match: explainMessageMatch(m, { jobsConfig, trackedNames, selfUser }),
      }));
      return res.json({ ok: true, count: explained.length, messages: explained });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: errText(err),
        code: err.code || 'WA_MESSAGES_FAILED',
      });
    }
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
