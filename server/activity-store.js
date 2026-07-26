/**
 * Durable cross-platform agent activity history (voice, Telegram, Cursor, MCP…).
 * Append-only JSONL under data/ — host GUI only; never broadcast to collaborators.
 */
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { v4 as uuidv4 } from 'uuid';
import { config } from './config.js';

const bus = new EventEmitter();
bus.setMaxListeners(40);

const MAX_MEMORY_EVENTS = 4000;
const MAX_ACTIVITY_SUMMARIES = 400;

/** @type {object[]} */
let events = [];
/** @type {Map<string, object>} */
const activities = new Map();

function activityFile() {
  return (
    process.env.AGENT_ACTIVITY_FILE ||
    path.join(config.root, 'data', 'agent-activity.jsonl')
  );
}

function ensureDir() {
  const dir = path.dirname(activityFile());
  fs.mkdirSync(dir, { recursive: true });
}

function trimMemory() {
  if (events.length > MAX_MEMORY_EVENTS) {
    events = events.slice(-MAX_MEMORY_EVENTS);
  }
  if (activities.size > MAX_ACTIVITY_SUMMARIES) {
    const sorted = [...activities.values()].sort((a, b) =>
      String(b.updatedAt).localeCompare(String(a.updatedAt))
    );
    activities.clear();
    for (const a of sorted.slice(0, MAX_ACTIVITY_SUMMARIES)) {
      activities.set(a.activityId, a);
    }
  }
}

function upsertActivity(event) {
  const id = event.activityId || event.runId || event.id;
  const prev = activities.get(id) || {
    activityId: id,
    startedAt: event.at,
    updatedAt: event.at,
    source: event.source,
    platform: event.platform,
    actorId: event.actorId || '',
    actorLabel: event.actorLabel || '',
    title: event.title || event.text?.slice(0, 120) || 'Activity',
    project: event.project || '',
    status: 'running',
    kinds: {},
    eventCount: 0,
    preview: '',
  };

  prev.updatedAt = event.at;
  prev.eventCount += 1;
  prev.kinds[event.kind] = (prev.kinds[event.kind] || 0) + 1;
  if (event.source) prev.source = event.source;
  if (event.platform) prev.platform = event.platform;
  if (event.actorId) prev.actorId = event.actorId;
  if (event.actorLabel) prev.actorLabel = event.actorLabel;
  if (event.project) prev.project = event.project;
  if (event.title && event.kind === 'run_start') prev.title = event.title;
  if (event.kind === 'run_end') prev.status = 'done';
  else if (event.kind === 'error' || event.type === 'error') prev.status = 'error';
  else if (prev.status !== 'error' && prev.status !== 'done') prev.status = 'running';

  const previewText = String(event.text || '').trim();
  if (previewText) prev.preview = previewText.slice(0, 180);

  activities.set(id, prev);
  return prev;
}

/**
 * Record one activity event (persisted + in-memory + subscribers).
 * @param {object} partial
 */
export function recordActivity(partial = {}) {
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

  events.push(event);
  const summary = upsertActivity(event);
  trimMemory();

  // Standalone Telegram / workers set AGENT_ACTIVITY_PERSIST=0 and POST to the
  // voice-agent instead — avoids double-writing the same JSONL on one machine.
  if (process.env.AGENT_ACTIVITY_PERSIST !== '0') {
    try {
      ensureDir();
      fs.appendFileSync(activityFile(), `${JSON.stringify(event)}\n`, 'utf8');
    } catch (err) {
      console.warn('[activity-store] persist failed:', err.message);
    }
  }

  bus.emit('event', event);
  bus.emit('activity', summary);
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
    return id ? `Telegram · ${id.slice(-4)}` : 'Telegram';
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

export function listActivities({
  limit = 80,
  query = '',
  filter = '',
  platform = '',
} = {}) {
  const q = String(query || filter || '')
    .trim()
    .toLowerCase();
  const plat = String(platform || '')
    .trim()
    .toLowerCase();
  let items = [...activities.values()];
  if (plat) {
    items = items.filter((a) => String(a.platform).toLowerCase() === plat);
  }
  if (q) {
    items = items.filter((a) => {
      const hay =
        `${a.title} ${a.preview} ${a.source} ${a.actorLabel} ${a.project}`.toLowerCase();
      return hay.includes(q);
    });
  }
  items.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return items.slice(0, Math.max(1, Math.min(200, Number(limit) || 80)));
}

export function getActivityEvents(activityId, { limit = 300 } = {}) {
  const id = String(activityId || '');
  if (!id) return [];
  const matched = events.filter((e) => e.activityId === id || e.runId === id);
  return matched.slice(-Math.max(1, Math.min(1000, Number(limit) || 300)));
}

export function getActivity(activityId) {
  return activities.get(String(activityId || '')) || null;
}

export function subscribeActivity(listener) {
  bus.on('event', listener);
  return () => bus.off('event', listener);
}

export function loadActivityStoreFromDisk() {
  const file = activityFile();
  try {
    if (!fs.existsSync(file)) return { loaded: 0 };
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split(/\r?\n/).filter(Boolean);
    const slice = lines.slice(-MAX_MEMORY_EVENTS);
    events = [];
    activities.clear();
    for (const line of slice) {
      try {
        const event = JSON.parse(line);
        events.push(event);
        upsertActivity(event);
      } catch {
        /* skip bad line */
      }
    }
    return { loaded: events.length };
  } catch (err) {
    console.warn('[activity-store] load failed:', err.message);
    return { loaded: 0, error: err.message };
  }
}

// Load on import so history survives restarts.
const boot = loadActivityStoreFromDisk();
if (boot.loaded) {
  console.log(`[activity-store] loaded ${boot.loaded} events from disk`);
}
