#!/usr/bin/env node
// Fails (or warns, with --warn-only) if .graph-context.md is older than the newest commit
// touching tracked source directories, or if it has grown past the token budget. Run before
// trusting the topology file for planning.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { encode } from 'gpt-tokenizer';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const topologyPath = path.join(repoRoot, '.graph-context.md');
const warnOnly = process.argv.includes('--warn-only');

const sourceDirs = ['server', 'client', 'scripts', 'shared'];
const TOKEN_BUDGET = 8000;

function fail(message) {
  if (warnOnly) {
    console.warn(`⚠ ${message}`);
    process.exit(0);
  }
  console.error(`✗ ${message}`);
  console.error('  Regenerate with: npm run build:graph');
  process.exit(1);
}

if (!fs.existsSync(topologyPath)) {
  fail('.graph-context.md does not exist.');
}

let latestCommitEpoch;
try {
  const out = execSync(
    `git log -1 --format=%ct -- ${sourceDirs.join(' ')}`,
    { cwd: repoRoot, encoding: 'utf8' }
  ).trim();
  latestCommitEpoch = out ? Number(out) : 0;
} catch {
  console.warn('⚠ Could not read git history — skipping freshness check.');
  process.exit(0);
}

const topologyMtimeEpoch = Math.floor(fs.statSync(topologyPath).mtimeMs / 1000);

if (latestCommitEpoch > topologyMtimeEpoch) {
  const staleDays = Math.round((latestCommitEpoch - topologyMtimeEpoch) / 86400);
  fail(
    `.graph-context.md is stale — the last commit touching ${sourceDirs.join('/')} ` +
      `is ~${staleDays} day(s) newer than the topology file.`
  );
}

const tokenCount = encode(fs.readFileSync(topologyPath, 'utf8')).length;
if (tokenCount > TOKEN_BUDGET) {
  fail(
    `.graph-context.md is ${tokenCount} tokens, over the ${TOKEN_BUDGET}-token budget. ` +
      'Tighten scripts/generate-topology.js (e.g. narrow SOURCE_EXT, exclude a noisy dir) ' +
      'rather than letting it grow back into a full-source dump.'
  );
}

console.log(`✔ .graph-context.md is up to date and within budget (${tokenCount}/${TOKEN_BUDGET} tokens).`);
