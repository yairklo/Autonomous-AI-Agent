#!/usr/bin/env node
/**
 * Manual / Coolify check: Cursor (+ optional Claude) CLI session health.
 *
 *   npm run cli-auth:health
 *   npm run cli-auth:health -- --claude
 *   npm run cli-auth:health -- --all
 */

import {
  checkClaudeAuth,
  checkCursorAuth,
} from '../server/cli-auth/health.js';

const args = process.argv.slice(2);
const wantClaude = args.includes('--claude') || args.includes('--all');
const wantCursor = !args.includes('--claude') || args.includes('--all');

function printResult(label, result) {
  const mark = result.ok ? 'OK' : 'FAIL';
  console.log(`[${mark}] ${label}: ${result.status} — ${result.reason}`);
  if (result.authUrl) console.log(`  authUrl: ${result.authUrl}`);
  if (result.elapsedMs != null) console.log(`  elapsedMs: ${result.elapsedMs}`);
  if (!result.ok && result.detail) {
    console.log(`  detail: ${String(result.detail).slice(0, 300)}`);
  }
}

const results = [];
if (wantCursor) {
  const cursor = await checkCursorAuth();
  printResult('cursor', cursor);
  results.push(cursor);
}
if (wantClaude) {
  const claude = await checkClaudeAuth();
  printResult('claude', claude);
  results.push(claude);
}

const ok = results.every((r) => r.ok);
process.exit(ok ? 0 : 1);
