/**
 * joinUp HTTP API for the thin Telegram bot.
 * Mounted on voice-agent; requires JOINUP_BOT_SHARED_SECRET.
 */
import crypto from 'node:crypto';
import {
  getJoinUpService,
  getJoinUpRunExtras,
  setJoinUpRunExtras,
  userIdFromClientId,
} from './joinup-service.js';
import { startRun, endRun, getRun, getRecentEvents } from './run-events.js';
import {
  formatStagingTelegramLines,
  redeployAndWatchStaging,
} from './joinup-telegram/render-staging.js';
import { formatCompletionMessage } from './joinup-telegram/executor.js';

function sharedSecret() {
  return String(process.env.JOINUP_BOT_SHARED_SECRET || '').trim();
}

/**
 * Timing-safe compare of bot shared secret.
 */
export function joinUpBotSecretOk(provided) {
  const expected = sharedSecret();
  if (!expected) return false;
  const a = Buffer.from(String(provided || ''), 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function requireJoinUpBotSecret(req, res, next) {
  if (!sharedSecret()) {
    return res.status(503).json({
      error: 'JOINUP_BOT_SHARED_SECRET is not configured on voice-agent',
    });
  }
  const header = req.get('x-joinup-bot-secret') || req.get('X-JoinUp-Bot-Secret') || '';
  if (!joinUpBotSecretOk(header)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return next();
}

/**
 * @param {import('express').Express} app
 */
export function mountJoinUpRoutes(app) {
  // GUI-facing routes (no secret required, expected to be called from the local web GUI)
  app.post('/api/gui/joinup/dispatch', async (req, res) => {
    try {
      const clientId = String(req.body?.clientId || '').trim();
      if (!clientId) return res.status(400).json({ error: 'clientId is required' });
      await triggerDispatch(clientId, req, res);
    } catch (err) {
      console.error('[joinup-http] gui dispatch error:', err);
      if (!res.headersSent) res.status(500).json({ error: err.message || String(err) });
    }
  });

  app.post('/api/gui/joinup/stop', async (req, res) => {
    try {
      const clientId = String(req.body?.clientId || '').trim();
      if (!clientId) return res.status(400).json({ error: 'clientId is required' });
      const userId = userIdFromClientId(clientId);
      const { agent } = getJoinUpService();
      agent.stopExecution(userId);
      res.json({ ok: true, status: 'stopped' });
    } catch (err) {
      console.error('[joinup-http] gui stop error:', err);
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  // Telegram bot routes (protected by secret)
  app.use('/api/joinup', requireJoinUpBotSecret);

  app.post('/api/joinup/chat', async (req, res) => {
    try {
      const clientId = String(req.body?.clientId || '').trim();
      const text = String(req.body?.text || '').trim();
      if (!clientId || !text) {
        return res.status(400).json({ error: 'clientId and text are required' });
      }
      const userId = userIdFromClientId(clientId);
      const { agent, joinUpRoot } = getJoinUpService();
      const result = await agent.handleMessage({
        userId,
        text,
        deferDispatch: true,
      });
      return res.json({
        clientId,
        userId,
        joinUpRoot,
        reply: result.reply || '',
        phase: result.phase,
        pendingBuild: Boolean(result.pendingBuild),
        needsDispatch: Boolean(result.needsDispatch),
      });
    } catch (err) {
      console.error('[joinup-http] chat error:', err);
      if (err?.code === 'CLI_AUTH_REQUIRED' || err?.code === 'CLI_AUTH_TIMEOUT') {
        return res.status(503).json({
          error: err.message || String(err),
          code: err.code,
          tool: err.tool || 'claude',
          authUrl: err.authUrl || '',
          queueId: err.queueId || '',
        });
      }
      return res.status(500).json({ error: err.message || String(err) });
    }
  });

  /**
   * Async dispatch — 202 + runId immediately; Cursor runs in background.
   */
  app.post('/api/joinup/dispatch', async (req, res) => {
    try {
      const clientId = String(req.body?.clientId || '').trim();
      if (!clientId) {
        return res.status(400).json({ error: 'clientId is required' });
      }
      await triggerDispatch(clientId, req, res);
    } catch (err) {
      console.error('[joinup-http] dispatch error:', err);
      if (!res.headersSent) res.status(500).json({ error: err.message || String(err) });
    }
  });

async function triggerDispatch(clientId, req, res) {
  const userId = userIdFromClientId(clientId);
  const { agent, store, joinUpRoot } = getJoinUpService();
  
  const customPrompt = String(req.body?.technicalPrompt || '').trim();
  if (customPrompt) {
    agent.forceSetPendingTask(userId, customPrompt);
  }
  
  const session = store.get(userId);
  const technicalPrompt = String(session.pendingTechnicalPrompt || '').trim();
  if (!technicalPrompt) {
    return res.status(409).json({
      error: 'No pending technical prompt — grill and confirm first',
    });
  }

  if (!session.pendingTechnicalPrompt) {
    store.update(userId, {
      pendingTechnicalPrompt: technicalPrompt,
      phase: 'awaiting_confirmation',
    });
  }

  const runId = startRun({
    source: 'joinup-telegram',
    project: joinUpRoot,
    title: technicalPrompt.slice(0, 120),
  });
  setJoinUpRunExtras(runId, {
    status: 'running',
    clientId,
    userId,
    joinUpRoot,
  });
  store.update(userId, { phase: 'executing', lastRunId: runId });

  res.status(202).json({
    runId,
    status: 'running',
    clientId,
    joinUpRoot,
  });

  const notifyTelegram = req.body?.notifyTelegram !== false;

  setImmediate(() => {
    void (async () => {
      try {
        const execResult = await agent.executePending(userId);
        const reply = execResult?.reply || '';
        const ok = Boolean(execResult?.dispatched) || execResult?.phase === 'completed';
        setJoinUpRunExtras(runId, {
          status: ok ? 'completed' : 'failed',
          ok,
          result: reply,
          vercelUrl: execResult?.vercelUrl || '',
          stagingUrl: execResult?.stagingUrl || '',
          phase: execResult?.phase,
        });
        endRun(runId, { ok, text: reply });
        
        if (notifyTelegram && process.env.JOINUP_TELEGRAM_BOT_TOKEN) {
          fetch(`https://api.telegram.org/bot${process.env.JOINUP_TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: userId, text: reply })
          }).catch(e => console.error('[joinup-http] telegram notify error:', e.message));
        }
      } catch (err) {
        const msg = err.message || String(err);
        console.error('[joinup-http] background dispatch failed:', msg);
        const reply = formatCompletionMessage({
          ok: false,
          error: msg,
        });
        setJoinUpRunExtras(runId, {
          status: 'failed',
          ok: false,
          result: reply,
          error: msg,
        });
        try {
          store.update(userId, { phase: 'awaiting_confirmation' });
        } catch {
          /* ignore */
        }
        endRun(runId, { ok: false, text: reply });
        
        if (notifyTelegram && process.env.JOINUP_TELEGRAM_BOT_TOKEN) {
          fetch(`https://api.telegram.org/bot${process.env.JOINUP_TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: userId, text: reply })
          }).catch(e => console.error('[joinup-http] telegram notify error:', e.message));
        }
      }
    })();
  });
}

  app.get('/api/joinup/runs/:runId', (req, res) => {
    const runId = String(req.params.runId || '').trim();
    const run = getRun(runId);
    const extras = getJoinUpRunExtras(runId);
    if (!run && !extras) {
      return res.status(404).json({ error: 'run not found', runId });
    }
    const status =
      extras?.status ||
      (run?.status === 'running'
        ? 'running'
        : run?.status === 'completed'
          ? 'completed'
          : run?.status === 'failed'
            ? 'failed'
            : run?.status || 'unknown');
    const events = getRecentEvents({ runId, limit: 50 });
    return res.json({
      runId,
      status,
      ok: extras?.ok ?? run?.ok,
      result: extras?.result ?? run?.result ?? '',
      error: extras?.error || '',
      vercelUrl: extras?.vercelUrl || '',
      stagingUrl: extras?.stagingUrl || '',
      clientId: extras?.clientId || '',
      project: run?.project || extras?.joinUpRoot || '',
      startedAt: run?.startedAt,
      updatedAt: extras?.updatedAt || run?.updatedAt,
      recentLogs: events.map((e) => e.text).filter(Boolean).slice(-20),
    });
  });

  app.post('/api/joinup/reset', (req, res) => {
    try {
      const clientId = String(req.body?.clientId || '').trim();
      if (!clientId) {
        return res.status(400).json({ error: 'clientId is required' });
      }
      const userId = userIdFromClientId(clientId);
      const { agent } = getJoinUpService();
      agent.resetUser(userId);
      return res.json({
        ok: true,
        clientId,
        phase: 'idle',
        pendingBuild: false,
      });
    } catch (err) {
      return res.status(500).json({ error: err.message || String(err) });
    }
  });

  app.post('/api/joinup/redeploy-staging', async (req, res) => {
    try {
      const staging = await redeployAndWatchStaging({
        force: req.body?.force !== false,
        onLog: (line) => console.log(line),
        timeoutMs: Number(process.env.JOINUP_STAGING_WAIT_MS || 420000),
      });
      const lines = formatStagingTelegramLines(staging);
      return res.json({
        ok: Boolean(staging.ok || staging.skipped),
        staging,
        text: lines.join('\n'),
      });
    } catch (err) {
      return res.status(500).json({ error: err.message || String(err) });
    }
  });
}
