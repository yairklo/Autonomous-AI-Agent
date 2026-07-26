import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-store-'));
process.env.AGENT_ACTIVITY_FILE = path.join(tmp, 'agent-activity.jsonl');

const {
  recordActivity,
  listActivities,
  getActivityEvents,
  recordFromRunEvent,
  loadActivityStoreFromDisk,
} = await import('../server/activity-store.js');

test('recordActivity groups by activityId and persists jsonl', () => {
  recordActivity({
    activityId: 'tg:1:day',
    kind: 'chat_user',
    source: 'joinup-telegram',
    platform: 'telegram',
    actorId: '6332016630',
    text: 'hello from friend',
    title: 'joinUp Telegram',
  });
  recordActivity({
    activityId: 'tg:1:day',
    kind: 'chat_assistant',
    source: 'joinup-telegram',
    platform: 'telegram',
    actorId: '6332016630',
    text: 'bot reply',
  });
  const list = listActivities({ platform: 'telegram' });
  assert.ok(list.some((a) => a.activityId === 'tg:1:day'));
  const events = getActivityEvents('tg:1:day');
  assert.equal(events.length >= 2, true);
  assert.ok(fs.existsSync(process.env.AGENT_ACTIVITY_FILE));
});

test('recordFromRunEvent stores cursor runs', () => {
  recordFromRunEvent({
    runId: 'run-abc',
    type: 'run_start',
    text: 'Cursor run started',
    source: 'dispatch',
    project: 'C:/JoinUpApp',
    at: new Date().toISOString(),
  });
  recordFromRunEvent({
    runId: 'run-abc',
    type: 'log',
    text: 'building…',
    source: 'dispatch',
    at: new Date().toISOString(),
  });
  const act = listActivities({ platform: 'cursor' }).find((a) => a.activityId === 'run-abc');
  assert.ok(act);
  assert.equal(act.status, 'running');
});

test('loadActivityStoreFromDisk reloads file', () => {
  const { loaded } = loadActivityStoreFromDisk();
  assert.ok(loaded >= 3);
});

console.log('activity-store tests: ok');
