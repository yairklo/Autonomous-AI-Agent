/**
 * Lightweight pre-dispatch CLI auth health probes (Cursor / Claude).
 * No browser automation — status/ping only, hard-killed on timeout.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { buildCursorAgentEnv } from './cursor-env.js';
import { extractAuthUrl, looksLikeAuthFailure } from './parse-auth-url.js';

export const DEFAULT_PROBE_TIMEOUT_MS = 20_000;

/**
 * @typedef {'ok'|'auth_required'|'binary_missing'|'timeout'|'unknown'} CliAuthStatus
 * @typedef {{
 *   ok: boolean,
 *   tool: 'cursor'|'claude',
 *   status: CliAuthStatus,
 *   reason: string,
 *   authUrl?: string,
 *   detail?: string,
 *   elapsedMs?: number,
 * }} CliAuthHealthResult
 */

/**
 * Resolve Cursor Agent binary candidates (same priority as dispatch-task).
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]}
 */
export function resolveCursorBinCandidates(env = process.env) {
  const override = String(env.CURSOR_BIN || '').trim();
  const home =
    String(env.HOME || env.USERPROFILE || '').trim() ||
    (process.platform === 'win32' ? env.USERPROFILE || '' : '/root');
  const localDir = path.join(env.LOCALAPPDATA || '', 'cursor-agent');
  const linuxLocalAgent = path.join(home, '.local', 'bin', 'agent');

  return [
    override,
    fs.existsSync(path.join(localDir, 'cursor-agent.ps1'))
      ? path.join(localDir, 'cursor-agent.ps1')
      : '',
    fs.existsSync(linuxLocalAgent) ? linuxLocalAgent : '',
    'agent',
    'cursor-agent',
    fs.existsSync(path.join(localDir, 'cursor-agent.cmd'))
      ? path.join(localDir, 'cursor-agent.cmd')
      : '',
    fs.existsSync(path.join(localDir, 'agent.cmd'))
      ? path.join(localDir, 'agent.cmd')
      : '',
    'cursor',
  ].filter(Boolean);
}

/**
 * @param {object} opts
 * @param {string} opts.command
 * @param {string[]} opts.args
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {number} [opts.timeoutMs]
 * @param {typeof spawn} [opts.spawnImpl]
 * @returns {Promise<{ code: number|null, stdout: string, stderr: string, timedOut: boolean }>}
 */
export function runProbeCommand({
  command,
  args,
  env = process.env,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  spawnImpl = spawn,
}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const child = spawnImpl(command, args, {
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    }, timeoutMs);

    child.stdout?.on('data', (c) => {
      stdout += c.toString();
    });
    child.stderr?.on('data', (c) => {
      stderr += c.toString();
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code: null,
        stdout,
        stderr: stderr || err.message || String(err),
        timedOut: false,
      });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

/**
 * Classify Cursor `agent status` (or similar) output.
 * @param {{ code: number|null, stdout: string, stderr: string, timedOut?: boolean }} result
 * @returns {Omit<CliAuthHealthResult, 'tool'|'elapsedMs'>}
 */
export function classifyCursorProbeResult(result) {
  const text = `${result.stdout || ''}\n${result.stderr || ''}`;
  const authUrl = extractAuthUrl(text);

  if (result.timedOut) {
    return {
      ok: false,
      status: 'timeout',
      reason: 'Cursor auth probe timed out',
      detail: text.slice(-500),
      ...(authUrl ? { authUrl } : {}),
    };
  }

  if (result.code === null) {
    const missing =
      /ENOENT|not found|is not recognized/i.test(result.stderr || '') ||
      /ENOENT|not found|is not recognized/i.test(text);
    return {
      ok: false,
      status: missing ? 'binary_missing' : 'unknown',
      reason: missing
        ? 'Cursor Agent CLI binary not found'
        : 'Cursor auth probe failed to start',
      detail: text.slice(-500),
    };
  }

  if (looksLikeAuthFailure(text) || /logged out|unauthorized/i.test(text)) {
    return {
      ok: false,
      status: 'auth_required',
      reason: 'Cursor CLI session is not authenticated',
      detail: text.slice(-500),
      ...(authUrl ? { authUrl } : {}),
    };
  }

  // Prefer explicit healthy signals when present.
  if (
    result.code === 0 &&
    /logged in|authenticated|email:|account:|subscription/i.test(text)
  ) {
    return {
      ok: true,
      status: 'ok',
      reason: 'Cursor CLI session is active',
      detail: text.slice(0, 400),
    };
  }

  if (result.code === 0) {
    // `agent status` may print sparse success; treat exit 0 without auth hints as ok.
    return {
      ok: true,
      status: 'ok',
      reason: 'Cursor CLI probe exited 0',
      detail: text.slice(0, 400),
    };
  }

  if (authUrl || looksLikeAuthFailure(text)) {
    return {
      ok: false,
      status: 'auth_required',
      reason: 'Cursor CLI requires login',
      detail: text.slice(-500),
      ...(authUrl ? { authUrl } : {}),
    };
  }

  return {
    ok: false,
    status: 'unknown',
    reason: `Cursor auth probe exited ${result.code}`,
    detail: text.slice(-500),
  };
}

/**
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {number} [opts.timeoutMs]
 * @param {typeof spawn} [opts.spawnImpl]
 * @param {(cmd: string, args: string[], env: NodeJS.ProcessEnv) => Promise<{code:number|null,stdout:string,stderr:string,timedOut?:boolean}>} [opts.runCommand]
 * @returns {Promise<CliAuthHealthResult>}
 */
export async function checkCursorAuth({
  env = process.env,
  timeoutMs = Number(env.CLI_AUTH_PROBE_TIMEOUT_MS || DEFAULT_PROBE_TIMEOUT_MS),
  spawnImpl = spawn,
  runCommand,
} = {}) {
  const started = Date.now();
  const childEnv = buildCursorAgentEnv(env);

  // Phase A short-circuit: API key path does not need browser session.
  if (String(childEnv.CURSOR_API_KEY || '').trim()) {
    return {
      ok: true,
      tool: 'cursor',
      status: 'ok',
      reason: 'CURSOR_API_KEY is set (skipping agent status)',
      elapsedMs: Date.now() - started,
    };
  }

  const candidates = resolveCursorBinCandidates(childEnv);
  let last = /** @type {CliAuthHealthResult|null} */ (null);

  for (const bin of candidates) {
    const base = path.basename(bin).toLowerCase();
    if (base === 'claude' || base.startsWith('claude.')) continue;

    let probe;
    if (runCommand) {
      probe = await runCommand(bin, ['status'], childEnv);
    } else if (/\.ps1$/i.test(bin)) {
      probe = await runProbeCommand({
        command: 'powershell.exe',
        args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', bin, 'status'],
        env: childEnv,
        timeoutMs,
        spawnImpl,
      });
    } else {
      probe = await runProbeCommand({
        command: bin,
        args: ['status'],
        env: childEnv,
        timeoutMs,
        spawnImpl,
      });
    }

    const classified = classifyCursorProbeResult(probe);
    last = {
      ...classified,
      tool: 'cursor',
      elapsedMs: Date.now() - started,
    };

    if (classified.status === 'binary_missing') continue;
    return last;
  }

  return (
    last || {
      ok: false,
      tool: 'cursor',
      status: 'binary_missing',
      reason: 'No Cursor Agent CLI binary found',
      elapsedMs: Date.now() - started,
    }
  );
}

/**
 * Optional Claude probe (chat path). Used by cli-auth:health; coding gate uses Cursor.
 * @param {object} [opts]
 * @returns {Promise<CliAuthHealthResult>}
 */
export async function checkClaudeAuth({
  env = process.env,
  timeoutMs = Number(env.CLI_AUTH_PROBE_TIMEOUT_MS || DEFAULT_PROBE_TIMEOUT_MS),
  spawnImpl = spawn,
  runCommand,
} = {}) {
  const started = Date.now();
  const bin = String(env.CLAUDE_BIN || 'claude').trim() || 'claude';
  const childEnv = {
    ...env,
    CI: env.CI || '1',
    NO_OPEN_BROWSER: env.NO_OPEN_BROWSER || '1',
    IS_SANDBOX: env.IS_SANDBOX || '1',
  };

  let probe;
  if (runCommand) {
    probe = await runCommand(
      bin,
      ['-p', 'ping', '--permission-mode', 'bypassPermissions'],
      childEnv
    );
  } else {
    probe = await runProbeCommand({
      command: bin,
      args: ['-p', 'ping', '--permission-mode', 'bypassPermissions'],
      env: childEnv,
      timeoutMs,
      spawnImpl,
    });
  }

  const text = `${probe.stdout || ''}\n${probe.stderr || ''}`;
  const authUrl = extractAuthUrl(text);
  const elapsedMs = Date.now() - started;

  if (probe.timedOut) {
    return {
      ok: false,
      tool: 'claude',
      status: 'timeout',
      reason: 'Claude auth probe timed out',
      detail: text.slice(-500),
      elapsedMs,
      ...(authUrl ? { authUrl } : {}),
    };
  }
  if (probe.code === null || /ENOENT|not found|is not recognized/i.test(text)) {
    return {
      ok: false,
      tool: 'claude',
      status: 'binary_missing',
      reason: 'Claude CLI binary not found',
      detail: text.slice(-500),
      elapsedMs,
    };
  }
  if (looksLikeAuthFailure(text)) {
    return {
      ok: false,
      tool: 'claude',
      status: 'auth_required',
      reason: 'Claude CLI session is not authenticated',
      detail: text.slice(-500),
      elapsedMs,
      ...(authUrl ? { authUrl } : {}),
    };
  }
  if (probe.code === 0) {
    return {
      ok: true,
      tool: 'claude',
      status: 'ok',
      reason: 'Claude CLI probe exited 0',
      detail: text.slice(0, 400),
      elapsedMs,
    };
  }
  return {
    ok: false,
    tool: 'claude',
    status: 'unknown',
    reason: `Claude auth probe exited ${probe.code}`,
    detail: text.slice(-500),
    elapsedMs,
  };
}

/**
 * @param {'cursor'|'claude'|'all'} [tool]
 * @param {object} [opts]
 */
export async function checkCliAuth(tool = 'cursor', opts = {}) {
  if (tool === 'claude') return checkClaudeAuth(opts);
  if (tool === 'all') {
    const cursor = await checkCursorAuth(opts);
    const claude = await checkClaudeAuth(opts);
    return { cursor, claude, ok: cursor.ok && claude.ok };
  }
  return checkCursorAuth(opts);
}
