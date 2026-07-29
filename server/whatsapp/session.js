/**
 * Non-blocking WhatsApp Web session (whatsapp-web.js + LocalAuth).
 * Never blocks HTTP boot — start() kicks initialize in the background.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { buildWhatsappPuppeteerOpts } from './puppeteer-opts.js';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');

export const WA_STATES = [
  'uninitialized',
  'qr_required',
  'connecting',
  'authenticated',
  'disconnected',
];

function defaultAuthPath() {
  return (
    String(process.env.WHATSAPP_AUTH_PATH || '').trim() ||
    path.join(root, '.wwebjs_auth')
  );
}

/**
 * @param {object} [opts]
 */
export function createWhatsappSession(opts = {}) {
  const onLog = opts.onLog || ((line) => console.log(line));
  const authPath = opts.authPath || defaultAuthPath();
  const createClientImpl = opts.createClient || null;
  const notifyQr = opts.notifyQr || null;

  let state = 'uninitialized';
  let lastQr = '';
  let lastQrAt = null;
  let authenticatedAt = null;
  let error = '';
  let client = null;
  let starting = false;
  let ready = false;
  /** @type {Set<(client: object, snap: object) => void>} */
  const readyListeners = new Set();

  function setState(next, detail = '') {
    state = next;
    if (detail) error = String(detail);
    else if (next === 'authenticated' || next === 'qr_required') error = '';
    if (next === 'disconnected' || next === 'connecting' || next === 'qr_required') {
      ready = false;
    }
    onLog(`[whatsapp-session] state=${state}${detail ? ` ${detail}` : ''}`);
  }

  function emitReady() {
    ready = true;
    const snap = snapshot();
    for (const fn of readyListeners) {
      try {
        fn(client, snap);
      } catch (err) {
        onLog(`[whatsapp-session] onReady listener failed: ${err.message}`);
      }
    }
  }

  function onReady(fn) {
    if (typeof fn !== 'function') return () => {};
    readyListeners.add(fn);
    if (ready && client) {
      try {
        fn(client, snapshot());
      } catch (err) {
        onLog(`[whatsapp-session] onReady late-call failed: ${err.message}`);
      }
    }
    return () => readyListeners.delete(fn);
  }

  function whenReady(fn) {
    return onReady(fn);
  }

  function snapshot() {
    return {
      state,
      hasQr: Boolean(lastQr),
      lastQrAt,
      authenticatedAt,
      error,
      authPath,
      starting,
    };
  }

  function getQr() {
    if (!lastQr) return null;
    return {
      qr: lastQr,
      at: lastQrAt,
      state,
    };
  }

  async function buildClient() {
    if (createClientImpl) {
      return createClientImpl({ onLog, authPath });
    }
    let wwebMod;
    try {
      wwebMod = await import('whatsapp-web.js');
    } catch (cause) {
      const err = new Error(
        'whatsapp-web.js is not installed. Run: npm install whatsapp-web.js'
      );
      err.code = 'WA_CLIENT_MISSING';
      err.cause = cause;
      throw err;
    }
    // ESM interop: LocalAuth lives on default export in current whatsapp-web.js.
    const wweb = wwebMod.default || wwebMod;
    const Client = wweb.Client || wwebMod.Client;
    const LocalAuth = wweb.LocalAuth || wwebMod.LocalAuth;
    if (typeof Client !== 'function' || typeof LocalAuth !== 'function') {
      const err = new Error(
        'whatsapp-web.js export shape unexpected (Client/LocalAuth missing)'
      );
      err.code = 'WA_CLIENT_EXPORT';
      throw err;
    }
    return new Client({
      authStrategy: new LocalAuth({ dataPath: authPath }),
      puppeteer: buildWhatsappPuppeteerOpts(),
    });
  }

  function wireClient(c) {
    if (typeof c.on !== 'function') return;

    c.on('qr', (qr) => {
      lastQr = String(qr || '');
      lastQrAt = new Date().toISOString();
      setState('qr_required');
      try {
        const qrcode = require('qrcode-terminal');
        onLog('[whatsapp-session] Scan QR (terminal):');
        qrcode.generate(lastQr, { small: true });
      } catch {
        onLog('[whatsapp-session] QR ready — GET /api/whatsapp/qr');
      }
      if (typeof notifyQr === 'function') {
        void Promise.resolve(notifyQr({ qr: lastQr, at: lastQrAt })).catch(
          (err) => onLog(`[whatsapp-session] notifyQr failed: ${err.message}`)
        );
      }
    });

    c.on('authenticated', () => {
      authenticatedAt = new Date().toISOString();
      setState('authenticated');
    });

    c.on('ready', () => {
      lastQr = '';
      authenticatedAt = authenticatedAt || new Date().toISOString();
      setState('authenticated', 'ready');
      emitReady();
    });

    c.on('auth_failure', (msg) => {
      setState('disconnected', `auth_failure: ${msg}`);
    });

    c.on('disconnected', (reason) => {
      setState('disconnected', String(reason || 'disconnected'));
    });
  }

  /**
   * Start session without blocking the caller on QR scan.
   * initialize() runs in background.
   */
  async function start() {
    if (state === 'authenticated' && client) {
      return snapshot();
    }
    if (starting) {
      return snapshot();
    }
    starting = true;
    error = '';
    setState('connecting');

    try {
      if (!client) {
        // Clean up SingletonLock in case of a previous crash
        const lockPath = path.join(authPath, 'session', 'SingletonLock');
        try {
          if (fs.existsSync(lockPath)) {
            fs.unlinkSync(lockPath);
            onLog(`[whatsapp-session] Removed stale SingletonLock at ${lockPath}`);
          }
        } catch (err) {
          onLog(`[whatsapp-session] Could not remove SingletonLock: ${err.message}`);
        }

        client = await buildClient();
        wireClient(client);
      }
      const initPromise =
        typeof client.initialize === 'function'
          ? client.initialize()
          : Promise.resolve();
      void initPromise
        .then(() => {
          starting = false;
        })
        .catch((err) => {
          starting = false;
          setState('disconnected', err.message || String(err));
        });
    } catch (err) {
      starting = false;
      setState('disconnected', err.message || String(err));
      throw err;
    }

    return snapshot();
  }

  async function stop() {
    starting = false;
    try {
      if (client && typeof client.destroy === 'function') {
        await client.destroy();
      }
    } catch (err) {
      onLog(`[whatsapp-session] destroy: ${err.message}`);
    }
    client = null;
    lastQr = '';
    setState('disconnected', 'stopped');
    return snapshot();
  }

  function getClient() {
    return client;
  }

  /** Test helper: inject state without real WA. */
  function _setStateForTests(next, qr = '', opts = {}) {
    state = next;
    if (qr) {
      lastQr = qr;
      lastQrAt = new Date().toISOString();
    }
    if (next === 'authenticated') {
      authenticatedAt = new Date().toISOString();
      lastQr = '';
    }
    if (opts.client) {
      client = opts.client;
    }
    if (opts.emitReady || (next === 'authenticated' && opts.client)) {
      emitReady();
    }
  }

  return {
    start,
    stop,
    snapshot,
    getQr,
    getClient,
    getState: () => state,
    onReady,
    whenReady,
    isReady: () => ready,
    _setStateForTests,
  };
}

/** Process-wide singleton for the voice-agent HTTP server. */
let shared = null;

export function getSharedWhatsappSession(opts = {}) {
  if (!shared) {
    shared = createWhatsappSession(opts);
  }
  return shared;
}

export function resetSharedWhatsappSessionForTests() {
  shared = null;
}
