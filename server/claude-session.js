import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

/**
 * Manages continuous Claude CLI conversations via print + resume.
 */
export class ClaudeSessionManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.sessions = new Map(); // clientId -> { sessionId, updatedAt }
    this.sessionsFile = options.sessionsFile || config.sessionsFile;
    this.mock = options.mock ?? config.mock;
    this.claudeBin = options.claudeBin || config.claudeBin;
    this.systemPrompt = options.systemPrompt || config.systemPrompt;
    this.timeoutMs = options.timeoutMs || config.claudeTimeoutMs;
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.sessionsFile)) {
        const raw = JSON.parse(fs.readFileSync(this.sessionsFile, 'utf8'));
        for (const [k, v] of Object.entries(raw)) {
          this.sessions.set(k, v);
        }
      }
    } catch {
      // ignore corrupt store
    }
  }

  _save() {
    const obj = Object.fromEntries(this.sessions.entries());
    fs.writeFileSync(this.sessionsFile, JSON.stringify(obj, null, 2));
  }

  getSession(clientId) {
    return this.sessions.get(clientId) || null;
  }

  reset(clientId) {
    this.sessions.delete(clientId);
    this._save();
  }

  /**
   * Stream a prompt turn. Yields events:
   * { type: 'text', text }
   * { type: 'session', sessionId }
   * { type: 'done', result }
   * { type: 'error', error }
   */
  async *ask(clientId, prompt, { signal } = {}) {
    const cleaned = String(prompt || '').trim();
    if (!cleaned) {
      yield { type: 'error', error: 'Empty prompt' };
      return;
    }

    if (this.mock) {
      yield* this._mockAsk(clientId, cleaned);
      return;
    }

    const existing = this.getSession(clientId);
    const args = [
      '-p',
      cleaned,
      '--output-format',
      'stream-json',
      '--verbose',
      '--system-prompt',
      this.systemPrompt,
      // Voice agent should not hang on tool permissions
      '--permission-mode',
      'bypassPermissions',
    ];

    if (existing?.sessionId) {
      args.push('--resume', existing.sessionId);
    }

    let sessionId = existing?.sessionId || null;
    let fullText = '';
    let sawResult = false;
    let rawStdout = '';

    try {
      for await (const event of this._runClaude(args, { signal })) {
        if (event.sessionId && event.sessionId !== sessionId) {
          sessionId = event.sessionId;
          this.sessions.set(clientId, {
            sessionId,
            updatedAt: new Date().toISOString(),
          });
          this._save();
          yield { type: 'session', sessionId };
        }

        if (event.type === 'raw_stdout') {
          rawStdout = event.rawStdout;
        }

        if (event.type === 'text' && event.text) {
          fullText += event.text;
          yield { type: 'text', text: event.text };
        }

        if (event.type === 'result') {
          sawResult = true;
          if (event.sessionId) {
            sessionId = event.sessionId;
            this.sessions.set(clientId, {
              sessionId,
              updatedAt: new Date().toISOString(),
            });
            this._save();
            yield { type: 'session', sessionId };
          }
          // Some builds only put final text on result
          if (event.result && !fullText) {
            fullText = event.result;
            yield { type: 'text', text: event.result };
          }
          yield { type: 'done', result: fullText || event.result || '' };
        }

        if (event.type === 'error') {
          const msg = event.error;
          if (existing?.sessionId && /resume|session|not found/i.test(msg)) {
            this.reset(clientId);
            yield {
              type: 'text',
              text: '[Session expired — starting a new conversation.]\n\n',
            };
            yield* this.ask(clientId, cleaned, { signal });
            return;
          }
          yield { type: 'error', error: msg };
          return;
        }
      }

      if (!sawResult || !fullText) {
        if (!fullText && rawStdout.trim()) {
          try {
            const obj = JSON.parse(rawStdout.trim());
            const text = obj.result || obj.content || obj.text || '';
            if (text) {
              fullText = text;
              yield { type: 'text', text };
            }
          } catch {
            const lines = rawStdout.split('\n');
            const plainLines = lines.filter(l => {
              const trimmed = l.trim();
              return trimmed && !trimmed.startsWith('{') && !trimmed.startsWith('}');
            });
            if (plainLines.length) {
              const text = plainLines.join('\n');
              fullText = text;
              yield { type: 'text', text };
            } else {
              fullText = rawStdout;
              yield { type: 'text', text: rawStdout };
            }
          }
        }
        yield {
          type: 'done',
          result: fullText || '(No response from Claude CLI)',
        };
      }
    } catch (err) {
      // If resume failed, retry once without resume
      const msg = err?.message || String(err);
      if (existing?.sessionId && /resume|session|not found/i.test(msg)) {
        this.reset(clientId);
        yield {
          type: 'text',
          text: '[Session expired — starting a new conversation.]\n\n',
        };
        yield* this.ask(clientId, cleaned, { signal });
        return;
      }
      yield { type: 'error', error: msg };
    }
  }

  async *_mockAsk(clientId, prompt) {
    const sessionId = this.getSession(clientId)?.sessionId || `mock-${clientId}`;
    this.sessions.set(clientId, {
      sessionId,
      updatedAt: new Date().toISOString(),
    });
    this._save();
    yield { type: 'session', sessionId };

    const reply =
      `Got it. You said: "${prompt.slice(0, 200)}". ` +
      `This is a mock voice-agent reply from the local server. ` +
      `When Claude CLI is connected, I will answer for real.`;

    for (const word of reply.split(/(\s+)/)) {
      yield { type: 'text', text: word };
      await delay(25);
    }
    yield { type: 'done', result: reply };
  }

  _runClaude(args, { signal } = {}) {
    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        let binToSpawn = self.claudeBin;
        let useShell = false;

        if (process.platform === 'win32') {
          // If the binary is already an absolute path ending in .exe, use it directly
          const isAbsoluteExe = path.isAbsolute(self.claudeBin) && self.claudeBin.toLowerCase().endsWith('.exe');
          if (!isAbsoluteExe) {
            // Search in PATH for claude.cmd or claude.exe
            const paths = (process.env.PATH || '').split(path.delimiter);
            let resolved = false;
            for (const dir of paths) {
              const cmdPath = path.join(dir, 'claude.cmd');
              if (fs.existsSync(cmdPath)) {
                const exePath = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
                if (fs.existsSync(exePath)) {
                  binToSpawn = exePath;
                  resolved = true;
                  break;
                }
              }
              const exeDirect = path.join(dir, 'claude.exe');
              if (fs.existsSync(exeDirect)) {
                binToSpawn = exeDirect;
                resolved = true;
                break;
              }
            }
            if (!resolved) {
              useShell = true;
            }
          }
        }

        let child;
        if (useShell) {
          const escapedArgs = args.map(arg => {
            return `"${arg.replace(/"/g, '\\"')}"`;
          });
          const cmdString = `"${binToSpawn}" ${escapedArgs.join(' ')}`;
          child = spawn(cmdString, {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
            shell: true,
            env: {
              ...process.env,
              CI: process.env.CI || '1',
            },
          });
        } else {
          child = spawn(binToSpawn, args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
            env: {
              ...process.env,
              CI: process.env.CI || '1',
            },
          });
        }

        child.stdin.end();

        let stderr = '';
        let buffer = '';
        let settled = false;
        const queue = [];
        let wake = null;

        const push = (item) => {
          queue.push(item);
          if (wake) {
            const w = wake;
            wake = null;
            w();
          }
        };

        const onAbort = () => {
          try {
            child.kill('SIGTERM');
          } catch {
            /* ignore */
          }
        };
        if (signal) {
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });
        }

        const timer = setTimeout(() => {
          onAbort();
          push({
            type: 'error',
            error: `Claude CLI timed out after ${self.timeoutMs}ms`,
          });
          push(null);
        }, self.timeoutMs);

        let rawStdout = '';
        child.stderr.on('data', (chunk) => {
          const text = chunk.toString();
          console.error('[Claude CLI STDERR]:', text);
          stderr += text;
        });

        child.stdout.on('data', (chunk) => {
          const text = chunk.toString();
          rawStdout += text;
          buffer += text;
          let idx;
          while ((idx = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (!line) continue;
            const parsed = parseStreamLine(line);
            for (const ev of parsed) push(ev);
          }
        });

        child.on('error', (err) => {
          push({
            type: 'error',
            error: `Failed to start Claude CLI (${self.claudeBin}): ${err.message}`,
          });
          push(null);
        });

        child.on('close', (code) => {
          clearTimeout(timer);
          if (signal) signal.removeEventListener('abort', onAbort);
          // flush remainder
          const rest = buffer.trim();
          if (rest) {
            for (const ev of parseStreamLine(rest)) push(ev);
          }
          push({ type: 'raw_stdout', rawStdout });
          if (code && code !== 0 && !settled) {
            const detail = stderr.trim().slice(-800) || `exit code ${code}`;
            push({ type: 'error', error: `Claude CLI failed: ${detail}` });
          }
          push(null);
        });

        while (true) {
          if (queue.length === 0) {
            await new Promise((r) => {
              wake = r;
            });
          }
          const item = queue.shift();
          if (item === null) break;
          if (item.type === 'error') settled = true;
          if (item.type === 'result') settled = true;
          yield item;
        }
      },
    };
  }
}

function parseStreamLine(line) {
  const events = [];
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    // Plain text fallback
    if (line) events.push({ type: 'text', text: line + '\n' });
    return events;
  }

  if (!obj || typeof obj !== 'object') {
    if (line) events.push({ type: 'text', text: line + '\n' });
    return events;
  }

  const sessionId =
    obj.session_id ||
    obj.sessionId ||
    obj?.message?.session_id ||
    null;

  if (sessionId) {
    events.push({ type: 'meta', sessionId });
  }

  // Handle standard result errors
  if (obj.is_error || (obj.errors && obj.errors.length) || obj.type === 'error') {
    const errorMsg =
      (obj.errors && obj.errors.join(', ')) ||
      obj.result ||
      obj.error?.message ||
      obj.message ||
      JSON.stringify(obj);

    events.push({
      type: 'error',
      error: errorMsg,
      sessionId,
    });
    return events;
  }

  // stream-json assistant content blocks
  if (obj.type === 'assistant' && obj.message?.content) {
    for (const block of obj.message.content) {
      if (block.type === 'text' && block.text) {
        events.push({ type: 'text', text: block.text, sessionId });
      }
    }
  }

  // stream_event content_block_delta
  if (obj.type === 'stream_event' || obj.type === 'content_block_delta') {
    const delta =
      obj.delta?.text ||
      obj.event?.delta?.text ||
      obj.content_block?.text ||
      '';
    if (delta) events.push({ type: 'text', text: delta, sessionId });
  }

  if (obj.type === 'content_block_delta' && obj.delta?.text) {
    events.push({ type: 'text', text: obj.delta.text, sessionId });
  }

  // nested event shapes
  if (obj.event?.type === 'content_block_delta' && obj.event?.delta?.text) {
    events.push({ type: 'text', text: obj.event.delta.text, sessionId });
  }

  if (obj.type === 'result') {
    events.push({
      type: 'result',
      result: obj.result || obj.content || '',
      sessionId: sessionId || obj.session_id,
      isError: false,
    });
  }

  return events;
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export default ClaudeSessionManager;
