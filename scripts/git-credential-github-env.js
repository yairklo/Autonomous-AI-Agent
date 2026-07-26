#!/usr/bin/env node
/**
 * Git credential helper — supplies GITHUB_TOKEN for github.com HTTPS.
 * Invoked by git as: node git-credential-github-env.js get|store|erase
 */
import fs from 'node:fs';

// git invokes: node git-credential-github-env.js <get|store|erase>
const action = process.argv[2] || '';
const token = String(process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim();

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

if (action === 'get') {
  // Consume stdin attributes (host/protocol/path) — we only handle github.com
  const input = readStdin();
  const host = /(?:^|\n)host=(.+)/.exec(input)?.[1]?.trim() || 'github.com';
  if (!token || !/github\.com$/i.test(host)) {
    process.exit(0);
  }
  process.stdout.write('protocol=https\n');
  process.stdout.write(`host=${host}\n`);
  process.stdout.write('username=x-access-token\n');
  process.stdout.write(`password=${token}\n`);
  process.exit(0);
}

// store / erase — token stays in Coolify env, not on disk
process.exit(0);
