/**
 * JSONL spill file when Mongo is down so live WhatsApp events are not lost.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function defaultBufferPath() {
  return (
    String(process.env.WHATSAPP_INGEST_BUFFER_PATH || '').trim() ||
    path.join(root, 'data', 'wa-ingest-buffer.jsonl')
  );
}

export function appendIngestBuffer(payload, bufferPath = defaultBufferPath()) {
  const target = path.resolve(bufferPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.appendFileSync(target, `${JSON.stringify(payload)}\n`, 'utf8');
  return target;
}

export function readAndClearIngestBuffer(bufferPath = defaultBufferPath()) {
  const target = path.resolve(bufferPath);
  if (!fs.existsSync(target)) return [];
  const raw = fs.readFileSync(target, 'utf8');
  fs.unlinkSync(target);
  const items = [];
  for (const line of raw.split(/\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      items.push(JSON.parse(trimmed));
    } catch {
      /* skip corrupt line */
    }
  }
  return items;
}
