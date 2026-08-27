/**
 * Non-blocking WhatsApp Web session (whatsapp-web.js + LocalAuth).
 * Never blocks HTTP boot — start() kicks initialize in the background.
 *
 * Reconnect: exponential backoff + jitter on transient drops.
 * Permanent logout (LOGOUT / UNPAIRED / NAVIGATION) does not loop — waits for QR.
 * After any disconnect, the Client is destroyed and a new instance is created.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { buildWhatsappClientOptions } from './client-opts.js';
import { unlinkChromeProfileLocks } from './chrome-locks.js';

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

const LOGOUT_RE = /LOGOUT|UNPAIRED|NAVIGATION|LOGGED.?OUT|CONFLICT/i;

export function isPermanentDisconnect(reason) {
  return LOGOUT_RE.test(String(reason || ''));
}

/** Chrome never started — do not spawn more clients (process leak / Code 21). */
export function isBrowserLaunchFailure(reason) {
  return /Failed to launch the browser process/i.test(String(reason || ''));
}

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
  const reconnectBaseMs = Number(opts.reconnectBaseMs ?? 1000);
  const reconnectMaxMs = Number(opts.reconnectMaxMs ?? 30000);
  const autoReconnect = opts.autoReconnect !== false;

  let state = 'uninitialized';
  let lastQr = '';
  let lastQrAt = null;
  let authenticatedAt = null;
  let lastEventAt = null;
  let error = '';
  let client = null;
  let starting = false;
  let ready = false;
  let stopping = false;
  let haltReconnect = false;
  let reconnectAttempt = 0;
  let reconnectTimer = null;
  let wired = false;
  /** @type {Set<(client: object, snap: object) => void>} */
  const readyListeners = new Set();

  function touch(detail = '') {
    lastEventAt = new Date().toISOString();
    if (detail) onLog(`[whatsapp-session] event ${detail}`);
  }

  function setState(next, detail = '') {
    state = next;
    if (detail) error = String(detail);
    else if (next === 'authenticated' || next === 'qr_required') error = '';
    if (next === 'disconnected' || next === 'connecting' || next === 'qr_required') {
      ready = false;
    }
    touch();
    onLog(`[whatsapp-session] state=${state}${detail ? ` ${detail}` : ''}`);
  }

  function emitReady() {
    ready = true;
    reconnectAttempt = 0;
    haltReconnect = false;
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
      lastEventAt,
      error,
      authPath,
      starting,
      ready,
      reconnectAttempt,
      haltReconnect,
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

  function clearReconnectTimer() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function scheduleReconnect(reason) {
    if (!autoReconnect || stopping || haltReconnect) return;
    clearReconnectTimer();
    const exp = reconnectBaseMs * 2 ** Math.min(reconnectAttempt, 8);
    const jitter = Math.floor(Math.random() * Math.min(400, reconnectBaseMs));
    const delay = Math.min(reconnectMaxMs, exp) + jitter;
    reconnectAttempt += 1;
    onLog(
      `[whatsapp-session] reconnect in ${delay}ms attempt=${reconnectAttempt} reason=${reason}`
    );
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void start().catch((err) =>
        onLog(`[whatsapp-session] reconnect failed: ${err.message}`)
      );
    }, delay);
  }

  async function destroyClient() {
    const current = client;
    client = null;
    wired = false;
    ready = false;
    if (!current) return;
    try {
      if (typeof current.destroy === 'function') await current.destroy();
    } catch (err) {
      onLog(`[whatsapp-session] destroy: ${err.message}`);
    }
  }

  async function handleDisconnect(reason) {
    if (stopping) return;
    const detail = String(reason || 'disconnected');
    setState('disconnected', detail);
    await destroyClient();
    if (isPermanentDisconnect(detail)) {
      haltReconnect = true;
      lastQr = '';
      setState('qr_required', `logged_out: ${detail}`);
      onLog('[whatsapp-session] permanent disconnect — waiting for QR / POST /api/whatsapp/start');
      return;
    }
    scheduleReconnect(detail);
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
    return new Client(buildWhatsappClientOptions({ LocalAuth, authPath }));
  }

  function wireClient(c) {
    if (typeof c.on !== 'function' || wired) return;
    wired = true;

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
      haltReconnect = true;
      void handleDisconnect(`auth_failure: ${msg}`);
    });

    c.on('disconnected', (reason) => {
      void handleDisconnect(reason);
    });
  }

  /**
   * Start session without blocking the caller on QR scan.
   * initialize() runs in background. Always builds a new Client after disconnect.
   */
  async function start() {
    if (stopping) {
      stopping = false;
    }
    if (state === 'authenticated' && client && ready) {
      return snapshot();
    }
    if (starting) {
      return snapshot();
    }
    if (
      client &&
      (state === 'connecting' ||
        state === 'qr_required' ||
        (state === 'authenticated' && !ready))
    ) {
      return snapshot();
    }
    haltReconnect = false;
    starting = true;
    error = '';
    setState('connecting');

    try {
      if (client) {
        await destroyClient();
      }
      unlinkChromeProfileLocks(authPath, onLog);
      client = await buildClient();
      wireClient(client);
      const initPromise =
        typeof client.initialize === 'function'
          ? client.initialize()
          : Promise.resolve();
      void initPromise
        .then(() => {
          starting = false;
        })
        .catch(async (err) => {
          starting = false;
          const detail = err.message || String(err);
          setState('disconnected', detail);
          await destroyClient();
          if (isBrowserLaunchFailure(detail)) {
            haltReconnect = true;
            onLog(
              '[whatsapp-session] Chrome launch failed — not retrying. Check PUPPETEER_EXECUTABLE_PATH / shm_size.'
            );
            return;
          }
          if (!stopping && autoReconnect && !haltReconnect) {
            scheduleReconnect(detail || 'initialize_failed');
          }
        });
    } catch (err) {
      starting = false;
      setState('disconnected', err.message || String(err));
      throw err;
    }

    return snapshot();
  }

  async function stop() {
    stopping = true;
    haltReconnect = true;
    starting = false;
    clearReconnectTimer();
    await destroyClient();
    unlinkChromeProfileLocks(authPath, onLog);
    lastQr = '';
    setState('disconnected', 'stopped');
    return snapshot();
  }

  function getClient() {
    return client;
  }

  function markEvent() {
    touch();
  }

  /** Test helper: inject state without real WA. */
  function _setStateForTests(next, qr = '', extra = {}) {
    state = next;
    if (qr) {
      lastQr = qr;
      lastQrAt = new Date().toISOString();
    }
    if (next === 'authenticated') {
      authenticatedAt = new Date().toISOString();
      lastQr = '';
      ready = true;
    }
    if (extra.client) {
      client = extra.client;
    }
    if (extra.emitReady || (next === 'authenticated' && extra.client)) {
      emitReady();
    }
    if (extra.haltReconnect != null) haltReconnect = Boolean(extra.haltReconnect);
  }

  async function reset() {
    await stop();
    stopping = false;
    haltReconnect = false;
    reconnectAttempt = 0;
    try {
      if (fs.existsSync(authPath)) {
        fs.rmSync(authPath, { recursive: true, force: true });
        onLog(`[whatsapp-session] wiped corrupted session at ${authPath}`);
      }
    } catch (err) {
      onLog(`[whatsapp-session] reset failed: ${err.message}`);
      throw err;
    }
    return snapshot();
  }

  return {
    start,
    stop,
    reset,
    snapshot,
    getQr,
    getClient,
    getState: () => state,
    onReady,
    whenReady,
    isReady: () => ready,
    markEvent,
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
