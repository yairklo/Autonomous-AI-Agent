/**
 * Capture Cursor CLI browser auth URL without opening a browser (NO_OPEN_BROWSER=1).
 * Spawns `agent login`, scrapes stdout/stderr for an https URL, then kills the process.
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
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {number} [opts.timeoutMs]
 * @param {typeof spawn} [opts.spawnImpl]
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
