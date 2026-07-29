/**
 * Keep a live `claude auth login` / `claude login` process so the human can
 * paste the browser login code back (required in Docker/SSH — no localhost callback).
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { extractAuthCode, extractAuthUrl } from './parse-auth-url.js';

function buildLoginEnv(base = process.env) {
  const env = {
    ...base,
    CI: base.CI || '1',
    NO_OPEN_BROWSER: '1',
  };
  const truthy = (v) =>
    ['1', 'true', 'yes', 'on'].includes(String(v || '').trim().toLowerCase());
  const isRoot =
    process.platform !== 'win32' &&
    typeof process.getuid === 'function' &&
    process.getuid() === 0;
  const inDocker = fs.existsSync('/.dockerenv');
  if (
    isRoot ||
    inDocker ||
    truthy(base.IS_SANDBOX) ||
    truthy(base.IS_SANDBOXED) ||
    truthy(base.ALLOW_ROOT)
  ) {
    env.IS_SANDBOX = '1';
  }
  return env;
}

/** @type {null | {
 *   child: import('node:child_process').ChildProcess,
 *   startedAt: number,
 *   authUrl: string,
 *   output: string,
 *   done: Promise<{ ok: boolean, code: number|null, output: string }>,
 *   resolveDone: Function,
 * }} */
let active = null;

export function getActiveClaudeLoginSession() {
  if (!active) return null;
  return {
    authUrl: active.authUrl,
    startedAt: active.startedAt,
    outputTail: active.output.slice(-800),
  };
}

export function hasActiveClaudeLoginSession() {
  return Boolean(active?.child && !active.child.killed);
}

/**
 * Start (or reuse) a Claude login child. Captures URL from stdout/stderr.
 * Does NOT kill the process — waits for submitClaudeLoginCode().
 *
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {number} [opts.urlWaitMs] how long to wait for a URL before returning
 * @returns {Promise<{ authUrl: string, authCodeFromCli: string, reused: boolean, output: string }>}
 */
export async function startClaudeLoginSession({
  env = process.env,
  urlWaitMs = Number(env.CLI_AUTH_LOGIN_CAPTURE_MS || 12_000),
} = {}) {
  if (active?.child && !active.child.killed) {
    return {
      authUrl: active.authUrl,
      authCodeFromCli: extractAuthCode(active.output),
      reused: true,
      output: active.output,
    };
  }

  const bin = String(env.CLAUDE_BIN || 'claude').trim() || 'claude';
  const childEnv = {
    ...buildClaudeCliEnv(env),
    NO_OPEN_BROWSER: '1',
    CI: env.CI || '1',
  };

  // Prefer modern `claude auth login`, then `claude login`.
  const argSets = [['auth', 'login'], ['login'], ['/login']];
  let lastErr = '';

  for (const args of argSets) {
    try {
      const session = spawnLogin(bin, args, childEnv);
      active = session;

      const deadline = Date.now() + Math.max(3000, urlWaitMs);
      while (Date.now() < deadline && !session.authUrl) {
        await new Promise((r) => setTimeout(r, 250));
        if (session.child.exitCode != null) break;
      }

      if (session.authUrl || session.child.exitCode == null) {
        return {
          authUrl: session.authUrl,
          authCodeFromCli: extractAuthCode(session.output),
          reused: false,
          output: session.output,
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
    authCodeFromCli: '',
    reused: false,
    output: lastErr,
  };
}

function spawnLogin(bin, args, env) {
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });

  const child = spawn(bin, args, {
    env,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
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
    resolveDone({
      ok: code === 0,
      code,
      output: session.output,
    });
    if (active === session) active = null;
  });

  return session;
}

/**
 * Paste browser login code into the waiting Claude login process.
 * @param {string} code
 * @returns {Promise<{ ok: boolean, message: string, output?: string }>}
 */
export async function submitClaudeLoginCode(code) {
  const cleaned = String(code || '').trim();
  if (!cleaned) {
    return { ok: false, message: 'Empty login code' };
  }
  if (!active?.child || active.child.killed || !active.child.stdin) {
    return {
      ok: false,
      message:
        'No active Claude login session. Send a chat message first to start login, or run npm run auth:claude on the VPS.',
    };
  }

  try {
    active.child.stdin.write(`${cleaned}\n`);
  } catch (err) {
    return { ok: false, message: err.message || String(err) };
  }

  const timeoutMs = Number(process.env.CLI_AUTH_CODE_WAIT_MS || 60_000);
  const result = await Promise.race([
    active.done,
    new Promise((resolve) =>
      setTimeout(
        () => resolve({ ok: false, code: null, output: active?.output || '', timedOut: true }),
        timeoutMs
      )
    ),
  ]);

  if (result.ok) {
    return {
      ok: true,
      message: 'Claude login successful',
      output: result.output?.slice(-500),
    };
  }
  if (result.timedOut) {
    // Process may still be waiting for another prompt — keep session alive.
    return {
      ok: false,
      message:
        'Submitted code; Claude login still running. If the browser shows another code, send it again. Or wait and retry chat.',
      output: result.output?.slice(-500),
    };
  }
  return {
    ok: false,
    message: `Claude login exited ${result.code}`,
    output: result.output?.slice(-500),
  };
}

export function cancelClaudeLoginSession() {
  if (!active?.child) return false;
  try {
    active.child.kill('SIGTERM');
  } catch {
    /* ignore */
  }
  active = null;
  return true;
}
