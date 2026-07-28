/**
 * Keep a live `agent login` process for Cursor DeepControl auth.
 *
 * IMPORTANT: the login URL contains a challenge/uuid bound to this process.
 * If we kill login after scraping the URL, browser approval cannot complete
 * and `agent status` stays auth_required forever.
 */

import path from 'node:path';
import { spawn } from 'node:child_process';
import { buildCursorAgentEnv } from './cursor-env.js';
import { extractAuthUrl } from './parse-auth-url.js';
import { resolveCursorBinCandidates } from './health.js';

/** @type {null | {
 *   child: import('node:child_process').ChildProcess,
 *   startedAt: number,
 *   authUrl: string,
 *   output: string,
 *   done: Promise<{ ok: boolean, code: number|null, output: string }>,
 *   resolveDone: Function,
 * }} */
let active = null;

export function getActiveCursorLoginSession() {
  if (!active) return null;
  return {
    authUrl: active.authUrl,
    startedAt: active.startedAt,
    running: Boolean(active.child && active.child.exitCode == null && !active.child.killed),
    outputTail: active.output.slice(-800),
  };
}

export function hasActiveCursorLoginSession() {
  return Boolean(active?.child && active.child.exitCode == null && !active.child.killed);
}

export function cursorLoginSessionSucceeded() {
  return Boolean(active && active.child?.exitCode === 0);
}

/**
 * Start (or reuse) Cursor login. Capture URL without killing the process.
 * @param {object} [opts]
 * @returns {Promise<{ authUrl: string, reused: boolean, output: string, running: boolean }>}
 */
export async function startCursorLoginSession({
  env = process.env,
  urlWaitMs = Number(env.CLI_AUTH_LOGIN_CAPTURE_MS || 12_000),
} = {}) {
  if (hasActiveCursorLoginSession()) {
    return {
      authUrl: active.authUrl,
      reused: true,
      output: active.output,
      running: true,
    };
  }

  // Previous session finished — clear so we can start fresh.
  if (active && active.child?.exitCode != null) {
    active = null;
  }

  const childEnv = buildCursorAgentEnv(env);
  const candidates = resolveCursorBinCandidates(childEnv);
  let lastErr = '';

  for (const bin of candidates) {
    const base = path.basename(bin).toLowerCase();
    if (base === 'claude' || base.startsWith('claude.')) continue;

    try {
      const session = spawnCursorLogin(bin, childEnv);
      active = session;

      const deadline = Date.now() + Math.max(3000, urlWaitMs);
      while (Date.now() < deadline && !session.authUrl) {
        await new Promise((r) => setTimeout(r, 250));
        if (session.child.exitCode != null) break;
      }

      const running =
        session.child.exitCode == null && !session.child.killed;
      if (session.authUrl || running) {
        return {
          authUrl: session.authUrl,
          reused: false,
          output: session.output,
          running,
        };
      }
      lastErr = session.output.slice(-300);
      active = null;
    } catch (err) {
      lastErr = err.message || String(err);
    }
  }

  return {
    authUrl: '',
    reused: false,
    output: lastErr || 'no cursor binary for login',
    running: false,
  };
}

function spawnCursorLogin(bin, env) {
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });

  let command = bin;
  let args = ['login'];
  if (/\.ps1$/i.test(bin)) {
    command = 'powershell.exe';
    args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', bin, 'login'];
  }

  const child = spawn(command, args, {
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const session = {
    child,
    startedAt: Date.now(),
    authUrl: '',
    output: '',
    done,
    resolveDone,
  };

  const onChunk = (buf) => {
    const t = buf.toString();
    session.output += t;
    if (!session.authUrl) {
      const url = extractAuthUrl(t) || extractAuthUrl(session.output);
      if (url) session.authUrl = url;
    }
  };

  child.stdout?.on('data', onChunk);
  child.stderr?.on('data', onChunk);
  child.on('error', (err) => {
    session.output += `\n${err.message}`;
    resolveDone({ ok: false, code: null, output: session.output });
    if (active === session) active = null;
  });
  child.on('close', (code) => {
    resolveDone({ ok: code === 0, code, output: session.output });
    // Keep `active` briefly so waiters can observe exitCode===0, then clear on next start.
    if (active === session && code !== 0) active = null;
  });

  return session;
}

/**
 * Whether the live login process has finished successfully (creds should be on disk).
 */
export async function waitForCursorLoginExit({
  timeoutMs = 5_000,
} = {}) {
  if (!active) return { ok: false, reason: 'no session' };
  if (active.child.exitCode === 0) {
    return { ok: true, reason: 'login process exited 0' };
  }
  if (active.child.exitCode != null) {
    return {
      ok: false,
      reason: `login process exited ${active.child.exitCode}`,
      output: active.output.slice(-500),
    };
  }
  const result = await Promise.race([
    active.done,
    new Promise((resolve) =>
      setTimeout(() => resolve({ ok: false, timedOut: true }), timeoutMs)
    ),
  ]);
  if (result.ok) return { ok: true, reason: 'login process exited 0' };
  if (result.timedOut) {
    return {
      ok: false,
      reason: 'login still running',
      running: true,
      authUrl: active.authUrl,
    };
  }
  return {
    ok: false,
    reason: `login process exited ${result.code}`,
    output: result.output?.slice(-500),
  };
}

export function cancelCursorLoginSession() {
  if (!active?.child) return false;
  try {
    active.child.kill('SIGTERM');
  } catch {
    /* ignore */
  }
  active = null;
  return true;
}
