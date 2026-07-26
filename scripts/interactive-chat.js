#!/usr/bin/env node
/**
 * Interactive terminal chat with the Claude Orchestrator (Grill-Me Mode by default).
 *
 * Usage:
 *   npm run chat
 *   npm run chat -- --mock
 *   npm run chat -- --url http://127.0.0.1:8787
 *
 * Starts a local server if none is listening, then reads line-by-line from stdin.
 * Type /help for commands. Ordinary coding requests enter Grill-Me Mode;
 * say "skip Grill-Me Mode and dispatch ..." (or "שגר ל-Cursor") to invoke
 * dispatch_coding_task after requirements are confirmed.
 */

import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const mock = args.includes('--mock') || process.env.VOICE_AGENT_MOCK === '1';
const urlIdx = args.indexOf('--url');
const baseUrl = (
  urlIdx >= 0 ? args[urlIdx + 1] : process.env.VOICE_AGENT_URL || 'http://127.0.0.1:8787'
).replace(/\/$/, '');

const clientId = `terminal-${randomUUID().slice(0, 8)}`;
let childServer = null;

function parseUrl(u) {
  const parsed = new URL(u);
  return {
    hostname: parsed.hostname,
    port: Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80)),
  };
}

async function healthOk() {
  try {
    const res = await fetch(`${baseUrl}/api/health`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return false;
    const data = await res.json();
    return data?.ok === true;
  } catch {
    return false;
  }
}

async function waitForHealth(timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await healthOk()) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function ensureServer() {
  if (await healthOk()) {
    console.log(`[chat] Connected to ${baseUrl}`);
    return;
  }

  console.log(`[chat] No server at ${baseUrl} — starting local voice-agent...`);
  const env = {
    ...process.env,
    HOST: process.env.HOST || '127.0.0.1',
    PORT: String(parseUrl(baseUrl).port || 8787),
  };
  if (mock) env.VOICE_AGENT_MOCK = '1';

  childServer = spawn(process.execPath, [path.join(root, 'server', 'index.js')], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  childServer.stdout.on('data', (chunk) => {
    const text = chunk.toString().trim();
    if (text) console.log(`[server] ${text}`);
  });
  childServer.stderr.on('data', (chunk) => {
    const text = chunk.toString().trim();
    if (text) console.error(`[server] ${text}`);
  });
  childServer.on('exit', (code) => {
    if (code && code !== 0) {
      console.error(`[chat] Server exited with code ${code}`);
    }
    childServer = null;
  });

  const ok = await waitForHealth();
  if (!ok) {
    console.error('[chat] Server failed to become healthy. Try: npm start');
    process.exit(1);
  }
  console.log(`[chat] Server ready at ${baseUrl} (mock=${mock ? '1' : '0'})`);
}

function postChatSse(text) {
  const { hostname, port } = parseUrl(baseUrl);
  const payload = JSON.stringify({ clientId, text });

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname,
        port,
        path: '/api/chat',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          Accept: 'text/event-stream',
        },
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () =>
            reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 400)}`))
          );
          return;
        }

        res.setEncoding('utf8');
        let buffer = '';
        let wrote = false;
        let errorMsg = null;

        res.on('data', (chunk) => {
          buffer += chunk;
          let split;
          while ((split = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, split);
            buffer = buffer.slice(split + 2);

            let event = '';
            let data = '';
            for (const line of block.split('\n')) {
              if (line.startsWith('event:')) event = line.slice(6).trim();
              if (line.startsWith('data:')) data += line.slice(5).trim();
            }
            if (!event || !data) continue;

            let parsed;
            try {
              parsed = JSON.parse(data);
            } catch {
              continue;
            }

            if (event === 'token' && parsed.text) {
              process.stdout.write(parsed.text);
              wrote = true;
            } else if (event === 'status' && parsed.stage) {
              const extra = parsed.tool ? ` tool=${parsed.tool}` : '';
              process.stdout.write(`\n[status] ${parsed.stage}${extra}\n`);
            } else if (event === 'tool_call') {
              process.stdout.write(
                `\n[tool_call] ${parsed.tool || 'dispatch_coding_task'}\n`
              );
            } else if (event === 'tool_result') {
              process.stdout.write(
                `\n[tool_result] ${parsed.tool || ''} ok=${parsed.ok}\n`
              );
            } else if (event === 'error') {
              errorMsg = parsed.error || 'unknown error';
              console.error(`\n[error] ${errorMsg}`);
            }
          }
        });

        res.on('end', () => {
          if (wrote) process.stdout.write('\n');
          if (errorMsg) reject(new Error(errorMsg));
          else resolve();
        });
      }
    );

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function resetSession() {
  const res = await fetch(`${baseUrl}/api/session/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId }),
  });
  if (!res.ok) throw new Error(`reset failed: ${res.status}`);
  console.log('[chat] Session reset. Grill-Me Mode starts fresh on the next coding request.');
}

function printHelp() {
  console.log(`
Commands:
  /help              Show this help
  /reset             Reset Claude conversation session
  /id                Print clientId
  /quit  or  /exit   Leave chat (stops auto-started server)

Grill-Me Mode (default):
  Describe a coding task — the orchestrator asks clarifying questions first.
  When requirements are confirmed, say e.g.:
    skip Grill-Me Mode and dispatch this to Cursor
    שגר ל-Cursor
  That invokes MCP tool dispatch_coding_task → Cursor Agent CLI.
`);
}

function shutdown() {
  if (childServer) {
    try {
      childServer.kill('SIGTERM');
    } catch {
      /* ignore */
    }
    childServer = null;
  }
}

async function main() {
  process.on('exit', shutdown);
  process.on('SIGINT', () => {
    console.log('\n[chat] bye');
    shutdown();
    process.exit(0);
  });

  await ensureServer();

  console.log('');
  console.log('=== Claude Orchestrator (interactive) ===');
  console.log(`clientId: ${clientId}`);
  console.log('Grill-Me Mode is ON by default for coding tasks.');
  console.log('Type /help for commands. Empty line is ignored.');
  console.log('');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  const prompt = () => rl.question('you> ', async (line) => {
    const text = String(line || '').trim();
    if (!text) {
      prompt();
      return;
    }

    if (text === '/quit' || text === '/exit') {
      rl.close();
      console.log('[chat] bye');
      shutdown();
      process.exit(0);
    }
    if (text === '/help') {
      printHelp();
      prompt();
      return;
    }
    if (text === '/id') {
      console.log(clientId);
      prompt();
      return;
    }
    if (text === '/reset') {
      try {
        await resetSession();
      } catch (err) {
        console.error('[chat]', err.message || err);
      }
      prompt();
      return;
    }

    process.stdout.write('agent> ');
    try {
      await postChatSse(text);
    } catch (err) {
      console.error(`\n[chat] ${err.message || err}`);
    }
    console.log('');
    prompt();
  });

  prompt();
}

main().catch((err) => {
  console.error('[chat] fatal:', err.message || err);
  shutdown();
  process.exit(1);
});
