/**
 * Chromium SingletonLock leftovers from a previous container/hostname
 * cause launch Code 21 ("profile in use by another Chromium process").
 */
import fs from 'node:fs';
import path from 'node:path';

const LOCK_RE = /^Singleton(Lock|Socket|Cookie)$/i;

export function unlinkChromeProfileLocks(authPath, onLog = () => {}) {
  const root = String(authPath || '').trim();
  if (!root) return 0;
  let n = 0;
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full);
        continue;
      }
      if (!LOCK_RE.test(ent.name)) continue;
      try {
        fs.unlinkSync(full);
        n += 1;
        onLog(`[whatsapp] removed stale ${ent.name} at ${full}`);
      } catch (err) {
        onLog(`[whatsapp] could not remove ${full}: ${err.message}`);
      }
    }
  };
  walk(root);
  return n;
}
