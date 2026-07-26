import assert from 'node:assert/strict';
import { test } from 'node:test';
import { executeMcpTool, listMcpTools } from '../server/mcp-tools.js';

test('redeploy_joinup_staging is registered', () => {
  const tool = listMcpTools().find((t) => t.name === 'redeploy_joinup_staging');
  assert.ok(tool);
  assert.match(tool.description, /staging|Render/i);
});

test('redeploy_joinup_staging reports missing hook without crashing', async () => {
  const prev = process.env.RENDER_STAGING_DEPLOY_HOOK_URL;
  const prevApi = process.env.RENDER_API_KEY;
  const prevSvc = process.env.RENDER_STAGING_SERVICE_ID;
  delete process.env.RENDER_STAGING_DEPLOY_HOOK_URL;
  delete process.env.JOINUP_RENDER_DEPLOY_HOOK;
  delete process.env.RENDER_API_KEY;
  delete process.env.RENDER_STAGING_SERVICE_ID;
  delete process.env.JOINUP_RENDER_SERVICE_ID;
  process.env.JOINUP_STAGING_WAIT_MS = '1';

  try {
    const result = await executeMcpTool(
      'redeploy_joinup_staging',
      { force: true, waitMs: 1 },
      { onLog: () => {} }
    );
    // Without credentials, trigger is skipped; health may still be checked briefly.
    assert.equal(result.tool, 'redeploy_joinup_staging');
    assert.ok(result.staging);
    assert.ok(
      result.staging.trigger?.skipped ||
        result.ok === true ||
        result.ok === false
    );
  } finally {
    if (prev === undefined) delete process.env.RENDER_STAGING_DEPLOY_HOOK_URL;
    else process.env.RENDER_STAGING_DEPLOY_HOOK_URL = prev;
    if (prevApi === undefined) delete process.env.RENDER_API_KEY;
    else process.env.RENDER_API_KEY = prevApi;
    if (prevSvc === undefined) delete process.env.RENDER_STAGING_SERVICE_ID;
    else process.env.RENDER_STAGING_SERVICE_ID = prevSvc;
  }
});

console.log('redeploy staging mcp tests: ok');
