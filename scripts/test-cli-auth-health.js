import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  classifyCursorProbeResult,
  checkCursorAuth,
} from '../server/cli-auth/health.js';
import {
  extractAuthUrl,
  looksLikeAuthFailure,
} from '../server/cli-auth/parse-auth-url.js';
import { assertCliAuthReady, waitForCliAuth } from '../server/cli-auth/gate.js';
import { buildCursorAgentEnv } from '../server/cli-auth/cursor-env.js';
import {
  parkTask,
  listParked,
  markAllResumeRequested,
  removeParked,
  expireParked,
} from '../server/cli-auth/queue.js';
import { notifyCliAuthRequired } from '../server/cli-auth/notify.js';

test('extractAuthUrl prefers login-looking URLs', () => {
  const text =
    'See docs https://example.com/docs then open https://cursor.com/login?token=abc';
  assert.equal(extractAuthUrl(text), 'https://cursor.com/login?token=abc');
  assert.equal(extractAuthUrl('no urls here'), '');
});

test('looksLikeAuthFailure detects common phrases', () => {
  assert.equal(looksLikeAuthFailure('Authentication required'), true);
  assert.equal(looksLikeAuthFailure('Please log in to continue'), true);
  assert.equal(looksLikeAuthFailure('Build succeeded'), false);
});

test('buildCursorAgentEnv forces HOME and NO_OPEN_BROWSER', () => {
  const env = buildCursorAgentEnv({ PATH: '/usr/bin' });
  assert.ok(env.HOME);
  assert.equal(env.NO_OPEN_BROWSER, '1');
  assert.equal(env.CI, '1');
  assert.equal(env.IS_SANDBOX, '1');
});

test('classifyCursorProbeResult: healthy exit 0', () => {
  const r = classifyCursorProbeResult({
    code: 0,
    stdout: 'Logged in as user@example.com\nSubscription: Pro\n',
    stderr: '',
  });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'ok');
});

test('classifyCursorProbeResult: auth required', () => {
  const r = classifyCursorProbeResult({
    code: 1,
    stdout: '',
    stderr:
      'Authentication required. Open https://cursor.com/auth/cli?code=xyz',
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'auth_required');
  assert.match(r.authUrl || '', /cursor\.com\/auth/);
});

test('classifyCursorProbeResult: timeout', () => {
  const r = classifyCursorProbeResult({
    code: null,
    stdout: '',
    stderr: '',
    timedOut: true,
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'timeout');
});

test('checkCursorAuth short-circuits on CURSOR_API_KEY', async () => {
  const result = await checkCursorAuth({
    env: { ...process.env, CURSOR_API_KEY: 'test-key' },
    runCommand: async () => {
      throw new Error('should not spawn when API key is set');
    },
  });
  assert.equal(result.ok, true);
  assert.match(result.reason, /CURSOR_API_KEY/);
});

test('checkCursorAuth returns auth_required from mocked status', async () => {
  const result = await checkCursorAuth({
    env: { ...process.env, CURSOR_API_KEY: '', CURSOR_BIN: 'agent' },
    runCommand: async () => ({
      code: 1,
      stdout: '',
      stderr: 'Authentication required',
      timedOut: false,
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'auth_required');
  assert.equal(result.tool, 'cursor');
});

test('assertCliAuthReady throws CLI_AUTH_REQUIRED', async () => {
  const queuePath = path.join(
    os.tmpdir(),
    `cli-auth-queue-test-${Date.now()}.json`
  );
  await assert.rejects(
    () =>
      assertCliAuthReady('cursor', {
        env: {
          ...process.env,
          CURSOR_API_KEY: '',
          CURSOR_BIN: 'agent',
          CLI_AUTH_WAIT_MS: '0',
          CLI_AUTH_QUEUE_PATH: queuePath,
          TELEGRAM_BOT_TOKEN: '',
          TELEGRAM_CHAT_ID: '',
        },
        skipWait: true,
        captureLoginUrl: async () => ({
          authUrl: 'https://cursor.com/auth/cli?code=test',
        }),
        runCommand: async () => ({
          code: 1,
          stdout: '',
          stderr: 'Authentication required',
          timedOut: false,
        }),
      }),
    (err) => {
      assert.equal(err.code, 'CLI_AUTH_REQUIRED');
      assert.equal(err.tool, 'cursor');
      assert.match(err.authUrl || '', /cursor\.com\/auth/);
      assert.ok(err.queueId);
      return true;
    }
  );
  const parked = listParked(queuePath);
  assert.ok(parked.length >= 1);
  try {
    fs.unlinkSync(queuePath);
  } catch {
    /* ignore */
  }
});

test('assertCliAuthReady passes when healthy', async () => {
  const result = await assertCliAuthReady('cursor', {
    env: { ...process.env, CURSOR_API_KEY: '', CURSOR_BIN: 'agent' },
    runCommand: async () => ({
      code: 0,
      stdout: 'Logged in as yair@example.com',
      stderr: '',
      timedOut: false,
    }),
  });
  assert.equal(result.ok, true);
});

test('waitForCliAuth recovers on later healthy probe', async () => {
  let n = 0;
  const result = await waitForCliAuth({
    env: { ...process.env, CURSOR_API_KEY: '' },
    timeoutMs: 5000,
    intervalMs: 10,
    runCommand: async () => {
      n += 1;
      if (n < 3) {
        return {
          code: 1,
          stdout: '',
          stderr: 'Authentication required',
          timedOut: false,
        };
      }
      return {
        code: 0,
        stdout: 'Logged in as ok@example.com',
        stderr: '',
        timedOut: false,
      };
    },
  });
  assert.equal(result.ok, true);
  assert.ok(n >= 3);
});

test('queue park / resume / expire', () => {
  const queuePath = path.join(
    os.tmpdir(),
    `cli-auth-queue-expire-${Date.now()}.json`
  );
  const item = parkTask(
    {
      project: '/tmp/proj',
      task: 'fix something',
      runId: 'run-1',
      authUrl: 'https://cursor.com/auth/x',
      reason: 'auth_required',
    },
    {
      filePath: queuePath,
      env: { CLI_AUTH_WAIT_MS: '600000' },
    }
  );
  assert.equal(item.status, 'awaiting_cli_auth');
  assert.equal(listParked(queuePath).length, 1);
  assert.equal(markAllResumeRequested(queuePath), 1);
  expireParked({ filePath: queuePath, now: Date.now() + 700_000 });
  assert.equal(listParked(queuePath).length, 0);
  removeParked(item.id, queuePath);
  try {
    fs.unlinkSync(queuePath);
  } catch {
    /* ignore */
  }
});

test('notifyCliAuthRequired dry-runs without telegram env', async () => {
  const result = await notifyCliAuthRequired({
    tool: 'cursor',
    authUrl: 'https://cursor.com/auth/cli',
    reason: 'test',
    env: { TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: '' },
  });
  assert.equal(result.ok, true);
  assert.equal(result.delivered, false);
  assert.match(result.text, /CLI authentication required/);
});

console.log('cli-auth-health tests: ok');
