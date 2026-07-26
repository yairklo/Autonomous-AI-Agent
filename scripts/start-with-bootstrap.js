#!/usr/bin/env node
/**
 * Coolify / production entry: bootstrap workspaces, then start the server.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrapWorkspace } from './bootstrap-workspace.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

async function main() {
  await bootstrapWorkspace();

  const server = path.join(repoRoot, 'server', 'index.js');
  const child = spawn(process.execPath, [server], {
    cwd: repoRoot,
    env: process.env,
    stdio: 'inherit',
  });

  const forward = (signal) => {
    try {
      child.kill(signal);
    } catch {
      /* ignore */
    }
  };
  process.on('SIGINT', () => forward('SIGINT'));
  process.on('SIGTERM', () => forward('SIGTERM'));

  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 1);
  });
}

main().catch((err) => {
  console.error(`[start] bootstrap/server failed: ${err.message}`);
  process.exit(1);
});
