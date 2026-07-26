import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  formatStagingTelegramLines,
  getJoinUpApiProductionUrl,
  getJoinUpStagingUrl,
  parseDeployIdFromHookBody,
  parseRenderServiceIdFromHook,
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

test('parse deploy / service ids from hook', () => {
  assert.equal(
    parseRenderServiceIdFromHook(
      'https://api.render.com/deploy/srv-abc123?key=xyz'
    ),
    'srv-abc123'
  );
  assert.equal(
    parseDeployIdFromHookBody(JSON.stringify({ deployId: 'dpl_hello' })),
    'dpl_hello'
  );
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

test('redeploy waits for unhealthy blip before trusting health (avoids old instance)', async () => {
  const prevHook = process.env.RENDER_STAGING_DEPLOY_HOOK_URL;
  const prevKey = process.env.RENDER_API_KEY;
  process.env.RENDER_STAGING_DEPLOY_HOOK_URL =
    'https://api.render.com/deploy/srv-test99?key=abc';
  delete process.env.RENDER_API_KEY;
  let healthCalls = 0;
  const fetchImpl = async (url, init = {}) => {
    if (String(url).includes('/deploy/srv-')) {
      assert.equal(init.method, 'POST');
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ deployId: 'dpl_test1' }),
      };
    }
    healthCalls += 1;
    // Calls 1-2: old instance still green
    // Call 3: rollout blip
    // Calls 4+: new instance
    if (healthCalls <= 2) {
      return { ok: true, status: 200, text: async () => '{"status":"OLD"}' };
    }
    if (healthCalls === 3) {
      return { ok: false, status: 502, text: async () => 'bad gateway' };
    }
    return { ok: true, status: 200, text: async () => '{"status":"NEW"}' };
  };

  try {
    const result = await redeployAndWatchStaging({
      force: true,
      fetchImpl,
      timeoutMs: 60000,
      pollMs: 5,
      graceMs: 60000,
      onLog: () => {},
    });
    assert.equal(result.ok, true);
    assert.equal(result.trigger.deployId, 'dpl_test1');
    assert.equal(result.health.sawUnhealthy, true);
    assert.ok(healthCalls >= 6); // blip + 3 consecutive OK
  } finally {
    if (prevHook === undefined) delete process.env.RENDER_STAGING_DEPLOY_HOOK_URL;
    else process.env.RENDER_STAGING_DEPLOY_HOOK_URL = prevHook;
    if (prevKey === undefined) delete process.env.RENDER_API_KEY;
    else process.env.RENDER_API_KEY = prevKey;
  }
});

test('with Render API key, waits for deploy live then health', async () => {
  const prevHook = process.env.RENDER_STAGING_DEPLOY_HOOK_URL;
  const prevKey = process.env.RENDER_API_KEY;
  process.env.RENDER_STAGING_DEPLOY_HOOK_URL =
    'https://api.render.com/deploy/srv-api1?key=k';
  process.env.RENDER_API_KEY = 'rnd_test';
  let deployPolls = 0;
  let healthCalls = 0;
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('/deploy/srv-api1') && init.method === 'POST') {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ deployId: 'dpl_live1' }),
      };
    }
    if (u.includes('/v1/services/srv-api1/deploys/dpl_live1')) {
      deployPolls += 1;
      const status = deployPolls < 2 ? 'build_in_progress' : 'live';
      return { ok: true, json: async () => ({ status }) };
    }
    healthCalls += 1;
    return { ok: true, status: 200, text: async () => '{"status":"OK"}' };
  };

  try {
    const result = await redeployAndWatchStaging({
      force: true,
      fetchImpl,
      timeoutMs: 60000,
      pollMs: 5,
      graceMs: 5,
      onLog: () => {},
    });
    assert.equal(result.ok, true);
    assert.equal(result.deploy?.status, 'live');
    assert.ok(healthCalls >= 3);
  } finally {
    if (prevHook === undefined) delete process.env.RENDER_STAGING_DEPLOY_HOOK_URL;
    else process.env.RENDER_STAGING_DEPLOY_HOOK_URL = prevHook;
    if (prevKey === undefined) delete process.env.RENDER_API_KEY;
    else process.env.RENDER_API_KEY = prevKey;
  }
});

test('formatCompletionMessage includes staging block', () => {
  const msg = formatCompletionMessage({
    ok: true,
    vercel: { url: 'https://preview.vercel.app', state: 'READY' },
    staging: {
      stagingUrl: 'https://my-app-staging-ijyp.onrender.com',
      trigger: { ok: true },
      health: { ok: true, waitedMs: 120000 },
    },
  });
  assert.ok(msg.includes('preview.vercel.app'));
  assert.ok(msg.includes('my-app-staging-ijyp.onrender.com'));
  assert.ok(msg.includes('בריאות השרת'));
});

console.log('joinUp render staging tests: ok');
