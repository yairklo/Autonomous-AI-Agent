import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  formatStagingTelegramLines,
  getJoinUpApiProductionUrl,
  getJoinUpStagingUrl,
  redeployAndWatchStaging,
} from '../server/joinup-telegram/render-staging.js';
import { formatCompletionMessage } from '../server/joinup-telegram/executor.js';

test('default staging / production API URLs are current hosts', () => {
  delete process.env.JOINUP_STAGING_URL;
  delete process.env.JOINUP_API_PRODUCTION_URL;
  assert.equal(
    getJoinUpStagingUrl(),
    'https://my-app-staging-ijyp.onrender.com'
  );
  assert.equal(getJoinUpApiProductionUrl(), 'https://joinup-api.duckdns.org');
  assert.ok(!getJoinUpStagingUrl().includes('joinupapp-1'));
});

test('formatStagingTelegramLines reports health failures', () => {
  const lines = formatStagingTelegramLines({
    stagingUrl: 'https://my-app-staging-ijyp.onrender.com',
    trigger: { ok: true },
    health: { ok: false },
    errors: ['health HTTP 502: bad gateway'],
  });
  assert.ok(lines.some((l) => /staging/i.test(l)));
  assert.ok(lines.some((l) => /502/.test(l)));
});

test('redeployAndWatchStaging triggers hook then waits for two healthy polls', async () => {
  const prevHook = process.env.RENDER_STAGING_DEPLOY_HOOK_URL;
  process.env.RENDER_STAGING_DEPLOY_HOOK_URL = 'https://example.com/deploy-hook';
  let healthCalls = 0;
  const fetchImpl = async (url, init = {}) => {
    if (String(url).includes('deploy-hook')) {
      assert.equal(init.method, 'POST');
      return { ok: true, status: 200, text: async () => 'ok' };
    }
    healthCalls += 1;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ status: 'ok' }),
    };
  };

  try {
    const result = await redeployAndWatchStaging({
      force: true,
      fetchImpl,
      timeoutMs: 60000,
      pollMs: 5,
      onLog: () => {},
    });
    assert.equal(result.ok, true);
    assert.equal(result.skipped, false);
    assert.equal(result.trigger.ok, true);
    assert.ok(healthCalls >= 2);
    assert.equal(result.stagingUrl, 'https://my-app-staging-ijyp.onrender.com');
  } finally {
    if (prevHook === undefined) delete process.env.RENDER_STAGING_DEPLOY_HOOK_URL;
    else process.env.RENDER_STAGING_DEPLOY_HOOK_URL = prevHook;
  }
});

test('formatCompletionMessage includes staging block', () => {
  const msg = formatCompletionMessage({
    ok: true,
    vercel: { url: 'https://preview.vercel.app', state: 'READY' },
    staging: {
      stagingUrl: 'https://my-app-staging-ijyp.onrender.com',
      trigger: { ok: true },
      health: { ok: true },
    },
  });
  assert.ok(msg.includes('preview.vercel.app'));
  assert.ok(msg.includes('my-app-staging-ijyp.onrender.com'));
  assert.ok(msg.includes('בריאות השרת'));
});

console.log('joinUp render staging tests: ok');
