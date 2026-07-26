import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  formatVercelTelegramLines,
  resolveJoinUpVercelUrl,
} from '../server/joinup-telegram/vercel.js';

test('formatVercelTelegramLines asks for tokens when url missing', () => {
  const lines = formatVercelTelegramLines({ state: 'MISSING_CREDENTIALS' });
  assert.ok(lines.some((l) => /VERCEL_TOKEN|GITHUB_TOKEN/i.test(l)));
  assert.ok(lines.some((l) => /preview|Dev/i.test(l)));
});

test('resolveJoinUpVercelUrl uses Vercel API without production target', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    assert.ok(!String(url).includes('target=production'));
    return {
      ok: true,
      json: async () => ({
        deployments: [
          {
            url: 'join-up-app-git-dev-acme.vercel.app',
            readyState: 'READY',
            target: null,
            meta: { githubCommitRef: 'Dev', githubCommitSha: 'deadbeefcafebabe' },
            uid: 'dpl_preview1',
          },
          {
            url: 'join-up-app.vercel.app',
            readyState: 'READY',
            target: 'production',
            meta: { githubCommitRef: 'main', githubCommitSha: '1111111' },
            uid: 'dpl_prod',
          },
        ],
      }),
    };
  };

  const result = await resolveJoinUpVercelUrl({
    token: 'tok',
    projectId: 'prj_1',
    gitBranch: 'Dev',
    gitSha: 'deadbeefcafebabe',
    fetchImpl,
    timeoutMs: 1000,
    pollMs: 10,
    onLog: () => {},
  });

  assert.equal(result.url, 'https://join-up-app-git-dev-acme.vercel.app');
  assert.equal(result.state, 'READY');
  assert.ok(calls[0].includes('/v6/deployments'));
});

test('resolveJoinUpVercelUrl ignores production host without credentials', async () => {
  const result = await resolveJoinUpVercelUrl({
    timeoutMs: 50,
    pollMs: 10,
    onLog: () => {},
  });
  assert.equal(result.url, '');
  assert.equal(result.state, 'MISSING_CREDENTIALS');
});

console.log('joinUp vercel preview tests: ok');
