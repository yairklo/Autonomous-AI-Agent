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
import { formatBidi as formatBidiUtil } from './format-bidi.js';

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

/**
 * Chat-interface wrapper: visually reorder Hebrew for LTR terminals.
 * English / code without Hebrew passes through unchanged.
 */
function formatBidi(text) {
  return formatBidiUtil(text);
}

function writeOut(text) {
  process.stdout.write(formatBidi(text));
}

function logOut(...parts) {
  console.log(...parts.map((p) => (typeof p === 'string' ? formatBidi(p) : p)));
}

function logErr(...parts) {
  console.error(...parts.map((p) => (typeof p === 'string' ? formatBidi(p) : p)));
}

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
    logOut(`[chat] Connected to ${baseUrl}`);
    return;
  }

  logOut(`[chat] No server at ${baseUrl} — starting local voice-agent...`);
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
    if (text) logOut(`[server] ${text}`);
  });
  childServer.stderr.on('data', (chunk) => {
    const text = chunk.toString().trim();
    if (text) logErr(`[server] ${text}`);
  });
  childServer.on('exit', (code) => {
    if (code && code !== 0) {
      logErr(`[chat] Server exited with code ${code}`);
    }
    childServer = null;
  });

  const ok = await waitForHealth();
  if (!ok) {
    logErr('[chat] Server failed to become healthy. Try: npm start');
    process.exit(1);
  }
  logOut(`[chat] Server ready at ${baseUrl} (mock=${mock ? '1' : '0'})`);
}

/**
 * Buffer streamed tokens and flush complete lines through formatBidi.
 * Partial Hebrew fragments must not be reordered mid-token.
 */
function createBidiStdoutWriter() {
  let buffer = '';
  let wrote = false;

  return {
    write(chunk) {
      buffer += String(chunk ?? '');
      wrote = true;
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx + 1);
        buffer = buffer.slice(idx + 1);
        writeOut(line);
      }
    },
    flush() {
      if (buffer) {
        writeOut(buffer);
        buffer = '';
      }
    },
    get wrote() {
      return wrote;
    },
  };
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
        let errorMsg = null;
        const out = createBidiStdoutWriter();

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
              out.write(parsed.text);
            } else if (event === 'status' && parsed.stage) {
              const extra = parsed.tool ? ` tool=${parsed.tool}` : '';
              writeOut(`\n[status] ${parsed.stage}${extra}\n`);
            } else if (event === 'tool_call') {
              writeOut(`\n[tool_call] ${parsed.tool || 'dispatch_coding_task'}\n`);
            } else if (event === 'tool_result') {
              writeOut(`\n[tool_result] ${parsed.tool || ''} ok=${parsed.ok}\n`);
            } else if (event === 'error') {
              errorMsg = parsed.error || 'unknown error';
              logErr(`\n[error] ${errorMsg}`);
            }
          }
        });

        res.on('end', () => {
          out.flush();
          if (out.wrote) process.stdout.write('\n');
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
  logOut('[chat] Session reset. Grill-Me Mode starts fresh on the next coding request.');
}

function printHelp() {
  logOut(`
Commands:
  /help              Show this help
  /reset             Reset Claude conversation session
  /id                Print clientId
  /quit  or  /exit   Leave chat (stops auto-started server)

Grill-Me Mode (default):
  Claude interviews YOU in this terminal (e.g. "שאל אותי … Grill-Me Pack").
  Cursor is NOT opened during the dialogue — only after you confirm at the end:
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
    logOut('\n[chat] bye');
    shutdown();
    process.exit(0);
  });

  await ensureServer();

  logOut('');
  logOut('=== Claude Orchestrator (interactive) ===');
  logOut(`clientId: ${clientId}`);
  logOut('Grill-Me Mode is ON by default for coding tasks.');
  logOut('Type /help for commands. Empty line is ignored.');
  logOut('');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  const prompt = () =>
    rl.question('you> ', async (line) => {
      const text = String(line || '').trim();
      if (!text) {
        prompt();
        return;
      }

      if (text === '/quit' || text === '/exit') {
        rl.close();
        logOut('[chat] bye');
        shutdown();
        process.exit(0);
      }
      if (text === '/help') {
        printHelp();
        prompt();
        return;
      }
      if (text === '/id') {
        logOut(clientId);
        prompt();
        return;
      }
      if (text === '/reset') {
        try {
          await resetSession();
        } catch (err) {
          logErr('[chat]', err.message || err);
        }
        prompt();
        return;
      }

      process.stdout.write('agent> ');
      try {
        await postChatSse(text);
      } catch (err) {
        logErr(`\n[chat] ${err.message || err}`);
      }
      logOut('');
      prompt();
    });

  prompt();
}

main().catch((err) => {
  logErr('[chat] fatal:', err.message || err);
  shutdown();
  process.exit(1);
});
