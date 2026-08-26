#!/usr/bin/env node
/**
 * One-time WhatsApp Web login for local / VPS / Docker.
 * Prints a QR code in the terminal — scan with WhatsApp → Linked devices.
 * Session is stored under .wwebjs_auth (persist this volume on Coolify).
 *
 * Usage:
 *   npm run whatsapp:connect
 *   docker exec -it <voice-agent-container> npm run whatsapp:connect
 *
 * Flags:
 *   --list-groups  After ready, print group chat names then exit
 *   --keep-alive   Stay connected until Ctrl+C (default: exit after ready)
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { buildWhatsappClientOptions } from '../server/whatsapp/client-opts.js';
import { sealClientAgainstSends } from '../server/jobs/whatsapp-live.js';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const authPath = path.join(root, '.wwebjs_auth');

const args = new Set(process.argv.slice(2));
const listGroups = args.has('--list-groups');
const keepAlive = args.has('--keep-alive') || listGroups;

function printQr(qr) {
  console.log('\n[whatsapp] Scan this QR with WhatsApp → Linked devices:\n');
  try {
    const qrcode = require('qrcode-terminal');
    qrcode.generate(qr, { small: true });
  } catch {
    console.log(qr);
    console.log(
      '\n[whatsapp] (Install qrcode-terminal for a terminal QR: npm i qrcode-terminal)'
    );
  }
  console.log('');
}

async function main() {
  let wweb;
  try {
    wweb = await import('whatsapp-web.js');
  } catch (cause) {
    console.error(
      '[whatsapp] whatsapp-web.js is not installed.\n' +
        '  Run: npm install whatsapp-web.js\n' +
        '  (It is an optionalDependency — install explicitly on the VPS if missing.)'
    );
    console.error(cause?.message || cause);
    process.exit(1);
  }

  const wwebPkg = wweb.default || wweb;
  const Client = wwebPkg.Client || wweb.Client;
  const LocalAuth = wwebPkg.LocalAuth || wweb.LocalAuth;
  if (typeof Client !== 'function' || typeof LocalAuth !== 'function') {
    console.error('[whatsapp] unexpected whatsapp-web.js export shape');
    process.exit(1);
  }
  console.log(`[whatsapp] LocalAuth path: ${authPath}`);
  console.log('[whatsapp] Creating client (headless Chromium)…');

  const client = new Client(
    buildWhatsappClientOptions({ LocalAuth, authPath })
  );
  // Defense in depth: this script never sends messages, but seal the client
  // anyway so a future edit here can't accidentally add a live send path
  // that bypasses the same safety guard the shared ingest session uses.
  sealClientAgainstSends(client, (line) => console.log(line));

  let exiting = false;
  const shutdown = async (code = 0) => {
    if (exiting) return;
    exiting = true;
    try {
      await client.destroy();
    } catch {
      /* ignore */
    }
    process.exit(code);
  };

  client.on('qr', printQr);

  client.on('authenticated', () => {
    console.log('[whatsapp] Authenticated — session will be saved to .wwebjs_auth');
  });

  client.on('auth_failure', (msg) => {
    console.error('[whatsapp] Auth failure:', msg);
    void shutdown(1);
  });

  client.on('disconnected', (reason) => {
    console.warn('[whatsapp] Disconnected:', reason);
    if (!exiting) void shutdown(1);
  });

  client.on('ready', async () => {
    console.log('[whatsapp] Ready — WhatsApp is linked.');
    console.log(
      '[whatsapp] Groups to watch come from config.json / data/whatsapp-groups.json (GUI Settings).'
    );

    if (listGroups) {
      try {
        const chats = await client.getChats();
        const groups = chats
          .filter((c) => c.isGroup)
          .map((c) => c.name)
          .filter(Boolean)
          .sort((a, b) => a.localeCompare(b));
        console.log(`\n[whatsapp] ${groups.length} group(s):`);
        for (const name of groups) console.log(`  - ${name}`);
        console.log(
          '\n[whatsapp] Copy exact names into Settings → WhatsApp groups (or config.json).'
        );
      } catch (err) {
        console.error('[whatsapp] Failed to list groups:', err.message);
      }
    }

    if (!keepAlive) {
      console.log('[whatsapp] Done. Re-run with --keep-alive to stay connected.');
      await shutdown(0);
      return;
    }

    console.log('[whatsapp] Keeping session alive — Ctrl+C to exit.');
  });

  process.on('SIGINT', () => {
    console.log('\n[whatsapp] Shutting down…');
    void shutdown(0);
  });
  process.on('SIGTERM', () => void shutdown(0));

  await client.initialize();
}

main().catch((err) => {
  console.error('[whatsapp] Fatal:', err.message || err);
  process.exit(1);
});
