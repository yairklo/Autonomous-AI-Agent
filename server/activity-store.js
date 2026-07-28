import { EventEmitter } from 'node:events';
import { v4 as uuidv4 } from 'uuid';
import { Activity } from './models/Activity.js';
import { config } from './config.js';

const bus = new EventEmitter();
bus.setMaxListeners(40);

/**
 * Record one activity event (persisted to MongoDB + subscribers).
 * @param {object} partial
 */
export async function recordActivity(partial = {}) {
  const event = {
    id: partial.id || uuidv4(),
    activityId: partial.activityId || partial.runId || `act-${uuidv4()}`,
    runId: partial.runId || '',
    at: partial.at || new Date().toISOString(),
    kind: partial.kind || partial.type || 'log',
    type: partial.type || partial.kind || 'log',
    source: partial.source || 'agent',
    platform: partial.platform || guessPlatform(partial.source),
    actorId: partial.actorId != null ? String(partial.actorId) : '',
    actorLabel: partial.actorLabel || defaultActorLabel(partial),
    title: partial.title || '',
    text: String(partial.text || ''),
    project: partial.project || '',
    meta: partial.meta || {},
  };

  bus.emit('event', event);

  if (config.mongoUri) {
    try {
      let status = 'pending';
      if (event.kind === 'run_end' || event.kind === 'done') status = 'success';
      else if (event.kind === 'error' || event.type === 'error') status = 'error';
      else if (event.kind === 'run_start') status = 'running';

      const act = new Activity({
        sessionId: event.activityId, // link to session via activityId/runId
        userId: event.actorId,
        channel: event.platform,
        actionType: event.kind,
        details: {
          text: event.text,
          title: event.title,
          source: event.source,
          project: event.project,
          meta: event.meta
        },
        status: status,
        error: status === 'error' ? event.text : undefined,
        createdAt: new Date(event.at)
      });
      await act.save();
    } catch (err) {
      console.warn('[activity-store] mongo save failed:', err.message);
    }
  }

  // To keep compatibility with UI that expects summaries, we can emit a mock summary
  // or fetch the latest status. For simplicity, we just emit the raw event.
  // The UI usually relies on 'activity' emit for list updates, we'll emit a basic one:
  bus.emit('activity', {
    activityId: event.activityId,
    updatedAt: event.at,
    title: event.title || event.text?.slice(0, 120) || 'Activity',
    status: event.kind === 'error' ? 'error' : (event.kind === 'run_end' ? 'done' : 'running')
  });

  return event;
}

function guessPlatform(source) {
  const s = String(source || '');
  if (s.includes('telegram') || s.includes('joinup')) return 'telegram';
  if (s.includes('voice') || s === 'agent') return 'voice';
  if (s.includes('dispatch') || s.includes('cursor')) return 'cursor';
  if (s.includes('mcp')) return 'mcp';
  return 'system';
}

function defaultActorLabel(partial) {
  if (partial.actorLabel) return partial.actorLabel;
  if (
    partial.platform === 'telegram' ||
    String(partial.source || '').includes('telegram')
  ) {
    const id = String(partial.actorId || '');
    return id ? `Telegram ...${id.slice(-4)}` : 'Telegram';
  }
  if (partial.platform === 'voice' || partial.source === 'voice') return 'Voice GUI';
  if (String(partial.source || '').includes('dispatch')) return 'Cursor dispatch';
  return 'Agent';
}

/** Map Cursor run-bus events into durable history. */
export function recordFromRunEvent(runEvent) {
  if (!runEvent) return null;
  const kind =
    runEvent.type === 'run_start'
      ? 'run_start'
      : runEvent.type === 'run_end'
        ? 'run_end'
        : runEvent.type === 'error'
          ? 'error'
          : 'cursor_log';
  return recordActivity({
    activityId: runEvent.runId,
    runId: runEvent.runId,
    at: runEvent.at,
    kind,
    type: runEvent.type,
    source: runEvent.source || 'dispatch',
    platform: String(runEvent.source || '').includes('telegram')
      ? 'telegram'
      : 'cursor',
    title: kind === 'run_start' ? runEvent.text : '',
    text: runEvent.text,
    project: runEvent.project || '',
    meta: runEvent.meta || {},
    actorLabel: String(runEvent.source || '').includes('telegram')
      ? 'Telegram → Cursor'
      : 'Cursor',
  });
}

export async function listActivities({
  limit = 80,
  query = '',
  filter = '',
  platform = '',
  userId = '',
  sessionId = '',
  page = 1
} = {}) {
  if (!config.mongoUri) return [];
  
  const q = {};
  if (platform) q.channel = platform;
  if (userId) q.userId = userId;
  if (sessionId) q.sessionId = sessionId;
  
  const search = query || filter;
  if (search) {
    q.$text = { $search: search };
  }

  const skip = (Math.max(1, page) - 1) * limit;

  try {
    const items = await Activity.find(q)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit))
      .exec();
    
    // Map back to the UI expected format
    return items.map(act => ({
      activityId: act.sessionId,
      updatedAt: act.createdAt,
      source: act.channel,
      platform: act.channel,
      actorId: act.userId,
      title: act.details?.title || act.details?.text?.slice(0, 120) || 'Activity',
      project: act.details?.project || '',
      status: act.status === 'success' ? 'done' : act.status,
      preview: act.details?.text?.slice(0, 180) || ''
    }));
  } catch (err) {
    console.warn('[activity-store] listActivities failed:', err.message);
    return [];
  }
}

export async function getActivityEvents(activityId, { limit = 300 } = {}) {
  const id = String(activityId || '');
  if (!id || !config.mongoUri) return [];
  
  try {
    const items = await Activity.find({ sessionId: id })
      .sort({ createdAt: 1 })
      .limit(Number(limit))
      .exec();
    
    return items.map(act => ({
      activityId: act.sessionId,
      runId: act.sessionId,
      at: act.createdAt,
      kind: act.actionType,
      type: act.actionType,
      text: act.details?.text || '',
      source: act.details?.source || '',
      platform: act.channel,
      meta: act.details?.meta || {}
    }));
  } catch (err) {
    console.warn('[activity-store] getActivityEvents failed:', err.message);
    return [];
  }
}

export async function getActivity(activityId) {
  if (!config.mongoUri) return null;
  try {
    const act = await Activity.findOne({ sessionId: String(activityId || '') }).sort({ createdAt: -1 }).exec();
    if (!act) return null;
    return {
      activityId: act.sessionId,
      updatedAt: act.createdAt,
      source: act.channel,
      platform: act.channel,
      actorId: act.userId,
      title: act.details?.title || act.details?.text?.slice(0, 120) || 'Activity',
      project: act.details?.project || '',
      status: act.status === 'success' ? 'done' : act.status,
      preview: act.details?.text?.slice(0, 180) || ''
    };
  } catch (err) {
    console.warn('[activity-store] getActivity failed:', err.message);
    return null;
  }
}

export function subscribeActivity(listener) {
  bus.on('event', listener);
  return () => bus.off('event', listener);
}

export function loadActivityStoreFromDisk() {
  // Deprecated JSONL loading. We now use MongoDB.
  return { loaded: 0, deprecated: true };
}
