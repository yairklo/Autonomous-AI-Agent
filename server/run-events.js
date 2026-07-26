/**
 * Live Cursor / dispatch run event bus.
 * - In-process publishers (MCP dispatch) emit here
 * - Standalone bots (joinUp Telegram) POST to /api/runs/events
 * - GUI + terminal subscribers consume SSE /api/runs/stream
 */
import { EventEmitter } from 'node:events';
import { v4 as uuidv4 } from 'uuid';
import { classifyCursorLogLine } from './cursor-log-parser.js';

const bus = new EventEmitter();
bus.setMaxListeners(50);

const MAX_BUFFER = 500;
/** @type {object[]} */
const buffer = [];
/** @type {Map<string, object>} */
const activeRuns = new Map();

/**
 * @param {Partial<{
 *   runId: string,
 *   type: string,
 *   text: string,
 *   source: string,
 *   project?: string,
 *   meta?: object,
 * }>} partial
 */
export function publishRunEvent(partial = {}) {
  const event = {
    id: uuidv4(),
    runId: partial.runId || 'global',
    type: partial.type || 'log',
    text: String(partial.text || ''),
    source: partial.source || 'agent',
    project: partial.project || '',
    meta: partial.meta || {},
    at: new Date().toISOString(),
  };

  buffer.push(event);
  if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER);

  const run = activeRuns.get(event.runId);
  if (run) {
    run.updatedAt = event.at;
    run.lastType = event.type;
    run.lastText = event.text;
    if (event.type === 'run_end' || event.type === 'error') {
      run.status = event.type === 'error' ? 'error' : 'done';
    }
  }

  bus.emit('event', event);
  // Also mirror to server terminal with a clear prefix.
  const prefix = `[run:${event.runId.slice(0, 8)}]`;
  const tag = event.type !== 'log' ? ` ${event.type}` : '';
  console.log(`${prefix}${tag} ${event.text}`);
  return event;
}

/**
 * Publish a raw log line after classifying Cursor/dispatch output.
 */
export function publishCursorLogLine(line, extras = {}) {
  const classified = classifyCursorLogLine(line);
  return publishRunEvent({
    ...extras,
    type: classified.type,
    text: classified.text,
    meta: { ...classified.meta, ...(extras.meta || {}) },
  });
}

export function startRun({ source = 'dispatch', project = '', title = '' } = {}) {
  const runId = uuidv4();
  const run = {
    runId,
    source,
    project,
    title,
    status: 'running',
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  activeRuns.set(runId, run);
  publishRunEvent({
    runId,
    type: 'run_start',
    source,
    project,
    text: title || `Cursor run started (${source})`,
    meta: { title },
  });
  return runId;
}

export function endRun(runId, { ok = true, text = '' } = {}) {
  publishRunEvent({
    runId,
    type: ok ? 'run_end' : 'error',
    text: text || (ok ? 'Cursor run finished' : 'Cursor run failed'),
  });
}

export function listActiveRuns() {
  return [...activeRuns.values()].sort((a, b) =>
    String(b.updatedAt).localeCompare(String(a.updatedAt))
  );
}

export function getRecentEvents({ runId, limit = 200 } = {}) {
  let items = buffer;
  if (runId) items = items.filter((e) => e.runId === runId);
  return items.slice(-limit);
}

export function subscribeRunEvents(listener) {
  bus.on('event', listener);
  return () => bus.off('event', listener);
}

/**
 * Create an onLog callback that publishes structured events + optional passthrough.
 */
export function createRunLogger({ runId, source = 'dispatch', project = '', onLog } = {}) {
  return (line) => {
    onLog?.(line);
    publishCursorLogLine(line, { runId, source, project });
  };
}
