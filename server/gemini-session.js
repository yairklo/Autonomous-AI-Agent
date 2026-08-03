import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import {
  detectGrillMePack,
  formatGrillMeReply,
} from './grill-me-packs.js';
import {
  getSharedGeminiRateLimiter,
  isRateLimitError,
} from './gemini-rate-limit.js';
import { executeMcpTool, listMcpTools } from './mcp-tools.js';

function getGeminiTools() {
  const mcpTools = listMcpTools();
  if (!mcpTools.length) return undefined;
  return [{
    functionDeclarations: mcpTools.map(t => {
      const params = t.inputSchema ? {
        type: 'OBJECT',
        properties: t.inputSchema.properties || {},
        required: t.inputSchema.required || []
      } : { type: 'OBJECT', properties: {} };
      return {
        name: t.name,
        description: t.description || t.name,
        parameters: params
      };
    })
  }];
}

/**
 * Gemini chat sessions with the same event shape as ClaudeSessionManager:
 * { type: 'text'|'session'|'done'|'error', ... }
 *
 * History is persisted client-side (no Claude-style --resume).
 */
export class GeminiSessionManager extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {string} [options.sessionsFile]
   * @param {boolean} [options.mock]
   * @param {string} [options.systemPrompt]
   * @param {string} [options.apiKey]
   * @param {string} [options.model]
   * @param {number} [options.timeoutMs]
   * @param {number} [options.maxHistoryMessages]
   * @param {import('./gemini-rate-limit.js').GeminiRateLimiter} [options.rateLimiter]
   * @param {typeof import('@google/genai').GoogleGenAI} [options.GoogleGenAI]
   * @param {(args: object) => AsyncIterable<{ text?: string }>|Promise<AsyncIterable<{ text?: string }>>} [options.streamFn]
   */
  constructor(options = {}) {
    super();
    this.sessions = new Map(); // clientId -> { sessionId, history, updatedAt }
    this.sessionsFile =
      options.sessionsFile || config.geminiSessionsFile || config.sessionsFile;
    this.mock = options.mock ?? config.mock;
    this.systemPrompt = options.systemPrompt || config.systemPrompt;
    this.apiKey = options.apiKey || config.geminiApiKey || '';
    this.model = options.model || config.geminiModel || 'gemini-3.6-flash';
    this.timeoutMs = options.timeoutMs || config.geminiTimeoutMs || config.claudeTimeoutMs;
    this.maxHistoryMessages = options.maxHistoryMessages ?? 40;
    this.rateLimiter =
      options.rateLimiter ||
      getSharedGeminiRateLimiter({
        rpm: config.geminiRpm,
        rpd: config.geminiRpd,
        onLog: (line) => console.log(line),
      });
    this._GoogleGenAI = options.GoogleGenAI || null;
    this._streamFn = options.streamFn || null;
    this._client = null;
    this._load();
  }

  /** @returns {{ provider: 'gemini', model: string }} */
  getProviderInfo() {
    return { provider: 'gemini', model: this.model };
  }

  _load() {
    try {
      if (fs.existsSync(this.sessionsFile)) {
        const raw = JSON.parse(fs.readFileSync(this.sessionsFile, 'utf8'));
        for (const [k, v] of Object.entries(raw)) {
          this.sessions.set(k, {
            sessionId: v.sessionId || `gemini-${k}`,
            history: Array.isArray(v.history) ? v.history : [],
            updatedAt: v.updatedAt || new Date().toISOString(),
          });
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

  async _getClient() {
    if (this._client) return this._client;
    if (!this.apiKey) {
      throw new Error(
        'GEMINI_API_KEY is not set. Add it to .env or the process environment.'
      );
    }
    let GoogleGenAI = this._GoogleGenAI;
    if (!GoogleGenAI) {
      ({ GoogleGenAI } = await import('@google/genai'));
    }
    this._client = new GoogleGenAI({ apiKey: this.apiKey });
    return this._client;
  }

  /**
   * @param {string} clientId
   * @param {string} prompt
   * @param {{ signal?: AbortSignal, source?: string, runId?: string }} [opts]
   */
  async *ask(clientId, prompt, { signal, source = 'unknown', runId } = {}) {
    const cleaned = String(prompt || '').trim();
    if (!cleaned) {
      yield { type: 'error', error: 'Empty prompt' };
      return;
    }

    if (this.mock) {
      yield* this._mockAsk(clientId, cleaned);
      return;
    }

    console.log(
      `[gemini] ask clientId=${clientId} model=${this.model} historyTurns=${this.getSession(clientId)?.history?.length || 0}`
    );

    let session = this.getSession(clientId);
    if (!session?.sessionId) {
      session = {
        sessionId: `gemini-${randomUUID()}`,
        history: [],
        updatedAt: new Date().toISOString(),
      };
      this.sessions.set(clientId, session);
      this._save();
    }
    yield { type: 'session', sessionId: session.sessionId };

    const history = Array.isArray(session.history) ? [...session.history] : [];
    const contents = [
      ...history,
      { role: 'user', parts: [{ text: cleaned }] },
    ];

    let fullText = '';
    let lastUsage = null;
    const startedAt = Date.now();
    let maxTurns = 10;
    let finalError = null;

    try {
      while (maxTurns-- > 0) {
        const stream = await this.rateLimiter.schedule(
          () => this._openStream(contents, signal),
          { signal }
        );

        let turnText = '';
        let functionCalls = [];

        for await (const chunk of stream) {
          if (signal?.aborted) {
            yield { type: 'error', error: 'Aborted' };
            return;
          }
          if (chunk?.usageMetadata) {
            lastUsage = chunk.usageMetadata;
          }
          if (chunk?.functionCalls?.length) {
            functionCalls.push(...chunk.functionCalls);
          } else {
            const parts = chunk?.candidates?.[0]?.content?.parts;
            if (Array.isArray(parts)) {
              const fc = parts.map(p => p.functionCall).filter(Boolean);
              if (fc.length) functionCalls.push(...fc);
            }
          }

          const text = extractChunkText(chunk);
          if (text) {
            turnText += text;
            fullText += text;
            yield { type: 'text', text };
          }
        }

        if (functionCalls.length > 0) {
          // Append the model's turn
          const modelParts = [];
          if (turnText) modelParts.push({ text: turnText });
          for (const fc of functionCalls) {
             modelParts.push({ functionCall: fc });
          }
          contents.push({ role: 'model', parts: modelParts });

          // Execute tools sequentially and collect responses
          const responseParts = [];
          for (const call of functionCalls) {
            try {
               const result = await executeMcpTool(call.name, call.args || {}, { onLog: console.log, signal });
               responseParts.push({
                 functionResponse: {
                   name: call.name,
                   response: { result }
                 }
               });
            } catch (err) {
               responseParts.push({
                 functionResponse: {
                   name: call.name,
                   response: { error: err.message }
                 }
               });
            }
          }
          contents.push({ role: 'user', parts: responseParts });
          continue; // Loop to let the model react to the tool responses
        }
        
        break; // No function calls, we are done
      }

      if (!fullText && !lastUsage) {
        yield {
          type: 'error',
          error: 'Empty response from Gemini (no text parts and no function calls processed)',
        };
        return;
      }

      const nextHistory = [
        ...history,
        { role: 'user', parts: [{ text: cleaned }] },
        { role: 'model', parts: [{ text: fullText }] },
      ].slice(-this.maxHistoryMessages);

      this.sessions.set(clientId, {
        sessionId: session.sessionId,
        history: nextHistory,
        updatedAt: new Date().toISOString(),
      });
      this._save();

      const durationMs = Date.now() - startedAt;
      yield {
        type: 'done',
        result: fullText,
        usage: lastUsage,
        durationMs,
        model: this.model,
      };
      void this._logUsage({
        source,
        runId,
        usage: lastUsage,
        durationMs,
      });
    } catch (err) {
      const msg = err?.message || String(err);
      const payload = {
        type: 'error',
        error: msg,
      };
      if (isRateLimitError(err)) {
        payload.code = err.code || 'GEMINI_RATE_LIMITED';
      } else if (err?.code) {
        payload.code = err.code;
      }
      yield payload;
    }
  }

  async _logUsage({ source = 'unknown', runId, usage, durationMs } = {}) {
    try {
      const { appendTokenUsage } = await import('./metrics/token-logger.js');
      appendTokenUsage({
        provider: 'gemini',
        model: this.model,
        usage: usage || {},
        durationMs,
        source,
        runId,
      });
    } catch (err) {
      console.warn('[gemini] token log failed:', err.message);
    }
  }

  async _openStream(contents, signal) {
    if (this._streamFn) {
      return this._streamFn({
        model: this.model,
        contents,
        systemInstruction: this.systemPrompt,
        signal,
      });
    }

    const ai = await this._getClient();
    const timeout = AbortSignal.timeout
      ? AbortSignal.timeout(this.timeoutMs)
      : undefined;
    const combined =
      signal && timeout
        ? AbortSignal.any
          ? AbortSignal.any([signal, timeout])
          : signal
        : signal || timeout;

    return ai.models.generateContentStream({
      model: this.model,
      contents,
      config: {
        systemInstruction: this.systemPrompt,
        abortSignal: combined,
        tools: getGeminiTools(),
      },
    });
  }

  async *_mockAsk(clientId, prompt) {
    const sessionId = this.getSession(clientId)?.sessionId || `mock-gemini-${clientId}`;
    const history = this.getSession(clientId)?.history || [];
    this.sessions.set(clientId, {
      sessionId,
      history: [
        ...history,
        { role: 'user', parts: [{ text: prompt }] },
        {
          role: 'model',
          parts: [{ text: '' }],
        },
      ].slice(-this.maxHistoryMessages),
      updatedAt: new Date().toISOString(),
    });

    const packId = detectGrillMePack(prompt);
    const locale = /[א-ת]/.test(prompt) ? 'he' : 'en';
    const reply = packId
      ? formatGrillMeReply(packId, { locale, openingLimit: 5 })
      : `Got it. You said: "${prompt.slice(0, 200)}". ` +
        `This is a mock Gemini voice-agent reply from the local server.`;

    // Patch last model turn with real reply for history continuity.
    const entry = this.sessions.get(clientId);
    if (entry?.history?.length) {
      entry.history[entry.history.length - 1] = {
        role: 'model',
        parts: [{ text: reply }],
      };
      this._save();
    }

    yield { type: 'session', sessionId };
    const chunkSize = packId ? 80 : 0;
    if (chunkSize > 0) {
      for (let i = 0; i < reply.length; i += chunkSize) {
        yield { type: 'text', text: reply.slice(i, i + chunkSize) };
        await delay(10);
      }
    } else {
      for (const word of reply.split(/(\s+)/)) {
        yield { type: 'text', text: word };
        await delay(15);
      }
    }
    yield { type: 'done', result: reply };
  }
}

function extractChunkText(chunk) {
  if (!chunk) return '';
  if (typeof chunk.text === 'string' && chunk.text) return chunk.text;
  if (typeof chunk.text === 'function') {
    try {
      const t = chunk.text();
      if (typeof t === 'string' && t) return t;
    } catch {
      /* ignore */
    }
  }
  const parts = chunk?.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    return parts.map((p) => p?.text || '').join('');
  }
  return '';
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export default GeminiSessionManager;
