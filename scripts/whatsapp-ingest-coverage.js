#!/usr/bin/env node
/**
 * Distinct WhatsApp chats that have stored raw messages in Mongo.
 *
 * Usage:
 *   npm run whatsapp:ingest-coverage
 *   npm run whatsapp:ingest-coverage -- --since=2026-08-01
 *
 * Mongo shell equivalent:
 *   db.whatsappmessages.aggregate([
 *     { $group: { _id: "$chatId", chatName: { $last: "$chatName" }, count: { $sum: 1 }, lastAt: { $max: "$timestamp" } } },
 *     { $sort: { count: -1 } }
 *   ])
 */

const sinceArg = process.argv.find((a) => a.startsWith('--since='));
const since = sinceArg ? sinceArg.slice('--since='.length) : '';
const base = (
  process.env.VOICE_AGENT_URL ||
  `http://127.0.0.1:${process.env.PORT || 8787}`
).replace(/\/$/, '');
const url = new URL(`${base}/api/whatsapp/ingest-coverage`);
if (since) url.searchParams.set('since', since);

const res = await fetch(url);
const body = await res.json().catch(() => ({}));
if (!res.ok || body.ok === false) {
  console.error(
    `[whatsapp:coverage] ${res.status} ${body.error || body.code || 'failed'}`
  );
  process.exit(1);
}

console.log(
  `[whatsapp:coverage] ${body.chatCount} chat(s), ${body.messageCount} message(s)` +
    (body.since ? ` since ${body.since}` : '')
);
for (const c of body.chats || []) {
  console.log(
    `  - ${c.chatName || '(unnamed)'}  ${c.chatId}  count=${c.count}  last=${c.lastAt || ''}`
  );
}
