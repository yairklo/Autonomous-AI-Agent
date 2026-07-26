#!/usr/bin/env node
/**
 * One-time Coolify / Docker helper: authenticate Claude CLI + Cursor CLI
 * using subscription browser login (no API keys).
 *
 * Usage (inside the running container):
 *   npm run auth:cli
 *   npm run auth:claude
 *   npm run auth:cursor
 *
 * Coolify terminal / SSH:
 *   docker compose exec -it app npm run auth:cli
 *   # or: docker exec -it <container> npm run auth:cli
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const mode = (process.argv[2] || 'all').toLowerCase();

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const CURSOR_BIN = process.env.CURSOR_BIN || 'agent';
const GIT_CONFIG =
  process.env.GIT_CONFIG_GLOBAL || '/root/.git-config-data/gitconfig';

function which(bin) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], {
    encoding: 'utf8',
  });
  return r.status === 0 ? String(r.stdout || '').split(/\r?\n/)[0].trim() : '';
}

function runInteractive(bin, args, { env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: 'inherit',
      env: {
        ...env,
        NO_OPEN_BROWSER: env.NO_OPEN_BROWSER || '1',
        CI: env.CI || '1',
      },
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${bin} ${args.join(' ')} exited ${code}`));
    });
  });
}

function ensureGitConfigDir() {
  const dir = path.dirname(GIT_CONFIG);
  fs.mkdirSync(dir, { recursive: true });
}

async function maybeWriteGitIdentity(rl) {
  ensureGitConfigDir();
  if (fs.existsSync(GIT_CONFIG)) {
    console.log(`✓ Git config already present: ${GIT_CONFIG}`);
    return;
  }
  const answer = (await rl.question('Configure git user.name / user.email now? [Y/n] '))
    .trim()
    .toLowerCase();
  if (answer === 'n' || answer === 'no') {
    console.log('Skipped git identity. You can set it later with:');
    console.log(`  git config --global user.name "Your Name"`);
    console.log(`  git config --global user.email "you@example.com"`);
    console.log(`(GIT_CONFIG_GLOBAL=${GIT_CONFIG})`);
    return;
  }
  const name = (await rl.question('git user.name: ')).trim();
  const email = (await rl.question('git user.email: ')).trim();
  if (!name || !email) {
    console.warn('⚠ Skipped git identity (name/email required).');
    return;
  }
  const body = `[user]\n\tname = ${name}\n\temail = ${email}\n`;
  fs.writeFileSync(GIT_CONFIG, body, 'utf8');
  console.log(`✓ Wrote ${GIT_CONFIG}`);
}

async function authClaude() {
  const resolved = which(CLAUDE_BIN) || CLAUDE_BIN;
  console.log('\n=== Claude CLI login (subscription) ===');
  console.log(`Binary: ${resolved}`);
  console.log('A login URL will be printed (NO_OPEN_BROWSER=1). Open it on your phone/PC.');
  console.log('Auth state persists in volume: claude_config → /root/.claude\n');
  // Prefer `claude login`; fall back to `claude /login` if needed.
  try {
    await runInteractive(CLAUDE_BIN, ['login']);
  } catch {
    console.warn('`claude login` failed — trying `claude /login`…');
    await runInteractive(CLAUDE_BIN, ['/login']);
  }
  console.log('✓ Claude login step finished. Verify with: claude -p "ping" --permission-mode bypassPermissions');
}

async function authCursor() {
  const resolved = which(CURSOR_BIN) || CURSOR_BIN;
  console.log('\n=== Cursor Agent CLI login (subscription) ===');
  console.log(`Binary: ${resolved}`);
  console.log('A login URL will be printed (NO_OPEN_BROWSER=1). Open it on your phone/PC.');
  console.log('Auth state persists in volume: cursor_config → /root/.cursor\n');
  try {
    await runInteractive(CURSOR_BIN, ['login']);
  } catch {
    console.warn('`agent login` failed — trying `auth` subcommand…');
    await runInteractive(CURSOR_BIN, ['auth']);
  }
  console.log('✓ Cursor login step finished. Verify with: agent status');
}

function printBanner() {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║  Autonomous Agent — one-time CLI authentication (Coolify)║
╠══════════════════════════════════════════════════════════╣
║  Volumes preserve login across redeploys:                ║
║    claude_config → /root/.claude                         ║
║    cursor_config → /root/.cursor                         ║
║    git_config    → /root/.git-config-data                ║
║                                                          ║
║  Coolify: open container Terminal, then:                 ║
║    npm run auth:cli                                      ║
║  Or from the VPS host:                                   ║
║    docker compose exec -it app npm run auth:cli          ║
╚══════════════════════════════════════════════════════════╝
`);
  console.log(`PATH claude: ${which(CLAUDE_BIN) || '(not found)'}`);
  console.log(`PATH cursor: ${which(CURSOR_BIN) || '(not found)'}`);
  console.log(`GIT_CONFIG_GLOBAL: ${GIT_CONFIG}`);
}

async function main() {
  printBanner();
  const rl = readline.createInterface({ input, output });
  try {
    if (mode === 'all' || mode === 'git') {
      await maybeWriteGitIdentity(rl);
    }
    if (mode === 'all' || mode === 'claude') {
      await authClaude();
    }
    if (mode === 'all' || mode === 'cursor') {
      await authCursor();
    }
    if (!['all', 'git', 'claude', 'cursor'].includes(mode)) {
      console.error(`Unknown mode: ${mode}. Use: all | claude | cursor | git`);
      process.exit(1);
    }
    console.log('\n✓ CLI auth helper finished. Redeploys keep sessions via named volumes.');
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error(`✗ auth:cli failed: ${err.message}`);
  process.exit(1);
});
