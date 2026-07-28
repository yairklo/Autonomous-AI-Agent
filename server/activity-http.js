import {
  getActivity,
  getActivityEvents,
  listActivities,
  recordActivity,
  subscribeActivity,
} from './activity-store.js';
import { getMessages } from './message-store.js';
import { Activity } from './models/Activity.js';
import { Message } from './models/Message.js';

/**
 * @param {import('express').Express} app
 */
export function mountActivityRoutes(app) {
  // Legacy alias
  app.get('/api/history', async (req, res) => {
    const limit = Number(req.query.limit || 80);
    const filter = String(req.query.q || '');
    const platform = String(req.query.platform || '');
    res.json({
      ok: true,
      activities: await listActivities({ limit, filter, platform }),
    });
  });

  // NEW endpoint: /api/activities
  // Supports query parameters: ?userId=...&channel=...&sessionId=...&limit=50&page=1
  app.get('/api/activities', async (req, res) => {
    const limit = Number(req.query.limit || 50);
    const page = Number(req.query.page || 1);
    const userId = req.query.userId || '';
    const channel = req.query.channel || '';
    const sessionId = req.query.sessionId || '';
    const filter = req.query.q || '';
    
    try {
      const activities = await listActivities({ limit, page, userId, platform: channel, sessionId, filter });
      res.json({ ok: true, activities });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // NEW endpoint: /api/messages
  // Fetch chat history filtered by userId, channel, or sessionId
  app.get('/api/messages', async (req, res) => {
    const limit = Number(req.query.limit || 50);
    const userId = req.query.userId || '';
    const channel = req.query.channel || '';
    const sessionId = req.query.sessionId || '';
    
    try {
      const messages = await getMessages({ limit, userId, channel, sessionId });
      res.json({ ok: true, messages });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // NEW endpoint: /api/search
  // Unified search endpoint allowing text search across messages and activities by keyword (?q=...&userId=...)
  app.get('/api/search', async (req, res) => {
    const q = req.query.q || '';
    const userId = req.query.userId || '';
    if (!q) return res.json({ ok: true, activities: [], messages: [] });
    
    try {
      const activityQuery = { $text: { $search: q } };
      if (userId) activityQuery.userId = userId;
      
      const messageQuery = { $text: { $search: q } };
      if (userId) messageQuery.userId = userId;
      
      const [activities, messages] = await Promise.all([
        Activity.find(activityQuery).sort({ createdAt: -1 }).limit(50).exec(),
        Message.find(messageQuery).sort({ createdAt: -1 }).limit(50).exec()
      ]);
      
      res.json({ ok: true, activities, messages });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Must be registered before /api/history/:activityId or "stream" is captured as an id → 404.
  app.get('/api/history/stream', async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    
    const recent = await listActivities({ limit: 40 });
    res.write(
      `event: hello\ndata: ${JSON.stringify({ ok: true, activities: recent.length })}\n\n`
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

  app.get('/api/history/:activityId', async (req, res) => {
    const activityId = String(req.params.activityId || '');
    const activity = await getActivity(activityId);
    const events = await getActivityEvents(activityId, {
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

  app.post('/api/activity', async (req, res) => {
    const body = req.body || {};
    const event = await recordActivity({
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
