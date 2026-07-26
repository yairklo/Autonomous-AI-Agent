/**
 * Host-only agent history API (voice GUI). Not exposed to Telegram collaborators.
 */
import {
  getActivity,
  getActivityEvents,
  listActivities,
  recordActivity,
  subscribeActivity,
} from './activity-store.js';

/**
 * @param {import('express').Express} app
 */
export function mountActivityRoutes(app) {
  app.get('/api/history', (req, res) => {
    const limit = Number(req.query.limit || 80);
    const filter = String(req.query.q || '');
    const platform = String(req.query.platform || '');
    res.json({
      ok: true,
      activities: listActivities({ limit, filter, platform }),
    });
  });

  app.get('/api/history/:activityId', (req, res) => {
    const activityId = String(req.params.activityId || '');
    const activity = getActivity(activityId);
    const events = getActivityEvents(activityId, {
      limit: Number(req.query.limit || 400),
    });
    if (!activity && events.length === 0) {
      return res.status(404).json({ error: 'activity not found' });
    }
    res.json({
      ok: true,
      activity: activity || { activityId, title: activityId },
      events,
    });
  });

  app.get('/api/history/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    res.write(
      `event: hello\ndata: ${JSON.stringify({ ok: true, activities: listActivities({ limit: 40 }).length })}\n\n`
    );

    const onEvent = (event) => {
      res.write(`event: activity_event\ndata: ${JSON.stringify(event)}\n\n`);
    };
    const unsub = subscribeActivity(onEvent);
    const heartbeat = setInterval(() => {
      res.write(`event: ping\ndata: ${JSON.stringify({ t: Date.now() })}\n\n`);
    }, 20000);
    req.on('close', () => {
      clearInterval(heartbeat);
      unsub();
    });
  });

  app.post('/api/activity', (req, res) => {
    const body = req.body || {};
    const event = recordActivity({
      activityId: body.activityId,
      runId: body.runId,
      kind: body.kind || body.type || 'log',
      type: body.type || body.kind || 'log',
      source: body.source || 'external',
      platform: body.platform || '',
      actorId: body.actorId || '',
      actorLabel: body.actorLabel || '',
      title: body.title || '',
      text: body.text || body.line || '',
      project: body.project || '',
      meta: body.meta || {},
    });
    res.json({ ok: true, event });
  });
}
