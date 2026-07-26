#!/usr/bin/env node
/**
 * Redeploy joinUp API staging on Render and wait for /api/health.
 *
 * Requires in .env:
 *   RENDER_STAGING_DEPLOY_HOOK_URL=...
 *   JOINUP_STAGING_URL=https://my-app-staging-ijyp.onrender.com
 *
 * Usage:
 *   npm run joinup:redeploy-staging
 *   node scripts/redeploy-joinup-staging.js --force
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDotEnv } from '../server/joinup-telegram/load-env.js';
import {
  formatStagingTelegramLines,
  redeployAndWatchStaging,
} from '../server/joinup-telegram/render-staging.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadDotEnv(path.resolve(__dirname, '..', '.env'));

// Explicit CLI invoke always redeploys (does not require detecting server/ diffs).
const result = await redeployAndWatchStaging({
  force: true,
  onLog: (line) => console.log(line),
  timeoutMs: Number(process.env.JOINUP_STAGING_WAIT_MS || 420000),
});

console.log(formatStagingTelegramLines(result).join('\n'));
console.log(
  JSON.stringify(
    {
      ok: result.ok,
      skipped: !!result.skipped,
      stagingUrl: result.stagingUrl,
      errors: result.errors || [],
    },
    null,
    2
  )
);

if (!result.ok && !result.skipped) process.exit(1);
if (result.trigger?.skipped && result.trigger?.error) process.exit(2);
