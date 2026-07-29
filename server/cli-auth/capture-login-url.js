/**
 * Capture Cursor/Claude CLI browser auth URLs without opening a browser.
 * Spawns `login`, scrapes stdout/stderr for an https URL, then kills the process.
 */

import path from 'node:path';
import { spawn } from 'node:child_process';
import { buildCursorAgentEnv } from './cursor-env.js';
import { extractAuthUrl } from './parse-auth-url.js';
import {
  resolveCursorBinCandidates,
  runProbeCommand,
} from './health.js';

export const DEFAULT_LOGIN_CAPTURE_MS = 12_000;

/**
 * @param {object} [opts]
 * @returns {Promise<{ authUrl: string, stdout: string, stderr: string }>}
 */
export async function captureCursorLoginUrl({
  env = process.env,
  timeoutMs = Number(env.CLI_AUTH_LOGIN_CAPTURE_MS || DEFAULT_LOGIN_CAPTURE_MS),
  spawnImpl = spawn,
} = {}) {
  const childEnv = buildCursorAgentEnv(env);
  const candidates = resolveCursorBinCandidates(childEnv);

  for (const bin of candidates) {
    const base = path.basename(bin).toLowerCase();
    if (base === 'claude' || base.startsWith('claude.')) continue;

    let probe;
    if (/\.ps1$/i.test(bin)) {
      probe = await runProbeCommand({
        command: 'powershell.exe',
        args: [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          bin,
          'login',
        ],
        env: childEnv,
        timeoutMs,
        spawnImpl,
      });
    } else {
      probe = await runProbeCommand({
        command: bin,
        args: ['login'],
        env: childEnv,
        timeoutMs,
        spawnImpl,
      });
    }

    const text = `${probe.stdout || ''}\n${probe.stderr || ''}`;
    if (/ENOENT|not found|is not recognized/i.test(text) && probe.code === null) {
      continue;
    }
    const authUrl = extractAuthUrl(text);
    return {
      authUrl,
      stdout: probe.stdout || '',
      stderr: probe.stderr || '',
    };
  }

  return { authUrl: '', stdout: '', stderr: 'no cursor binary for login capture' };
}

/**
 * @param {object} [opts]
 * @returns {Promise<{ authUrl: string, stdout: string, stderr: string }>}
 */
export async function captureClaudeLoginUrl({
  env = process.env,
  timeoutMs = Number(env.CLI_AUTH_LOGIN_CAPTURE_MS || DEFAULT_LOGIN_CAPTURE_MS),
  spawnImpl = spawn,
} = {}) {
  const bin = String(env.CLAUDE_BIN || 'claude').trim() || 'claude';
  const childEnv = {
    ...env,
    CI: env.CI || '1',
    NO_OPEN_BROWSER: env.NO_OPEN_BROWSER || '1',
    IS_SANDBOX: env.IS_SANDBOX || '1',
  };

  // Prefer `claude login`; fall back to `/login` if needed.
  let probe = await runProbeCommand({
    command: bin,
    args: ['login'],
    env: childEnv,
    timeoutMs,
    spawnImpl,
  });
  let text = `${probe.stdout || ''}\n${probe.stderr || ''}`;
  let authUrl = extractAuthUrl(text);

  if (!authUrl && !/ENOENT|not found|is not recognized/i.test(text)) {
    probe = await runProbeCommand({
      command: bin,
      args: ['/login'],
      env: childEnv,
      timeoutMs,
      spawnImpl,
    });
    text = `${probe.stdout || ''}\n${probe.stderr || ''}`;
    authUrl = extractAuthUrl(text);
  }

  return {
    authUrl,
    stdout: probe.stdout || '',
    stderr: probe.stderr || '',
  };
}

/**
 * @param {'cursor'|'claude'} tool
 * @param {object} [opts]
 */
export async function captureLoginUrlForTool(tool, opts = {}) {
  if (tool === 'claude') return captureClaudeLoginUrl(opts);
  return captureCursorLoginUrl(opts);
}
