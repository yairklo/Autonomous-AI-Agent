/**
 * HTTP bridge so standalone processes (joinUp Telegram bot) can publish
 * Cursor live logs into the voice-agent run console.
 */
import {
  getRecentEvents,
  listActiveRuns,
  publishCursorLogLine,
  publishRunEvent,
  startRun,
  endRun,
  subscribeRunEvents,
} from './run-events.js';

/**
 * @param {import('express').Express} app
 */
export function mountRunEventsRoutes(app) {
  app.get('/api/runs', (_req, res) => {
    res.json({
      ok: true,
      active: listActiveRuns(),
      recent: getRecentEvents({ limit: 100 }),
    });
  });

  app.get('/api/runs/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const runId = String(req.query.runId || '').trim();
    const recent = getRecentEvents({ runId: runId || undefined, limit: 150 });
    res.write(`event: hello\ndata: ${JSON.stringify({ ok: true, replay: recent.length })}\n\n`);
    for (const event of recent) {
      res.write(`event: run_event\ndata: ${JSON.stringify(event)}\n\n`);
    }

    const onEvent = (event) => {
      if (runId && event.runId !== runId) return;
      res.write(`event: run_event\ndata: ${JSON.stringify(event)}\n\n`);
    };
    const unsubscribe = subscribeRunEvents(onEvent);

    const heartbeat = setInterval(() => {
      res.write(`event: ping\ndata: ${JSON.stringify({ t: Date.now() })}\n\n`);
    }, 15000);

    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  // Ingest from standalone bots / workers
  app.post('/api/runs/start', (req, res) => {
    const runId = startRun({
      source: String(req.body?.source || 'external'),
      project: String(req.body?.project || ''),
      title: String(req.body?.title || ''),
    });
    res.json({ ok: true, runId });
  });

  app.post('/api/runs/events', (req, res) => {
    const body = req.body || {};
    if (body.line != null) {
      const event = publishCursorLogLine(String(body.line), {
        runId: body.runId,
        source: body.source || 'external',
        project: body.project || '',
      });
      return res.json({ ok: true, event });
    }
    const event = publishRunEvent({
      runId: body.runId,
      type: body.type || 'log',
      text: body.text || '',
      source: body.source || 'external',
      project: body.project || '',
      meta: body.meta || {},
    });
    res.json({ ok: true, event });
  });

  app.post('/api/runs/end', (req, res) => {
    const runId = String(req.body?.runId || '').trim();
    if (!runId) return res.status(400).json({ error: 'runId required' });
    endRun(runId, {
      ok: req.body?.ok !== false,
      text: String(req.body?.text || ''),
    });
    res.json({ ok: true });
  });
}
