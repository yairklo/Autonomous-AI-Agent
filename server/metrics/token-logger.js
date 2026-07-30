/**
 * Lightweight append-only token / cost logger (JSONL).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Langfuse } from 'langfuse';

let langfuseClient = null;
if (process.env.LANGFUSE_SECRET_KEY && process.env.LANGFUSE_PUBLIC_KEY) {
  langfuseClient = new Langfuse({
    secretKey: process.env.LANGFUSE_SECRET_KEY,
    publicKey: process.env.LANGFUSE_PUBLIC_KEY,
    baseUrl: process.env.LANGFUSE_HOST || process.env.LANGFUSE_BASE_URL || "https://cloud.langfuse.com"
  });
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');

/** USD per 1M tokens — approximate public rates; override via env. */
export const DEFAULT_RATES = {
  claude: {
    // Sonnet-class default
    inputPerMTok: Number(process.env.TOKEN_RATE_CLAUDE_IN || 3),
    outputPerMTok: Number(process.env.TOKEN_RATE_CLAUDE_OUT || 15),
  },
  gemini: {
    // Flash-class default
    inputPerMTok: Number(process.env.TOKEN_RATE_GEMINI_IN || 0.1),
    outputPerMTok: Number(process.env.TOKEN_RATE_GEMINI_OUT || 0.4),
  },
  cursor: {
    inputPerMTok: 0,
    outputPerMTok: 0,
  },
};

export function defaultLogPath(env = process.env) {
  return (
    String(env.TOKEN_USAGE_LOG_PATH || '').trim() ||
    path.join(root, 'data', 'token-usage.jsonl')
  );
}

/**
 * @param {object} opts
 * @param {'claude'|'gemini'|'cursor'} opts.provider
 * @param {string} [opts.model]
 * @param {number} [opts.inputTokens]
 * @param {number} [opts.outputTokens]
 * @param {number} [opts.totalTokens]
 * @param {number} [opts.estimatedCostUsd] if set, preferred over table estimate
 * @param {number} [opts.durationMs]
 * @param {string} [opts.source]
 * @param {string} [opts.runId]
 * @param {string} [opts.timestamp]
 */
export function estimateCostUsd({
  provider,
  inputTokens = 0,
  outputTokens = 0,
  estimatedCostUsd,
} = {}) {
  if (
    estimatedCostUsd != null &&
    Number.isFinite(Number(estimatedCostUsd))
  ) {
    return Number(estimatedCostUsd);
  }
  const rates = DEFAULT_RATES[provider] || DEFAULT_RATES.claude;
  const inCost = (Number(inputTokens) || 0) * (rates.inputPerMTok / 1_000_000);
  const outCost =
    (Number(outputTokens) || 0) * (rates.outputPerMTok / 1_000_000);
  return roundUsd(inCost + outCost);
}

function roundUsd(n) {
  return Math.round(n * 1e6) / 1e6;
}

/**
 * Normalize Claude CLI usage object or Gemini usageMetadata.
 */
export function normalizeUsage(provider, raw = {}) {
  if (!raw || typeof raw !== 'object') {
    return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  }

  if (provider === 'gemini') {
    const input =
      Number(raw.promptTokenCount ?? raw.inputTokens ?? 0) || 0;
    const output =
      Number(
        raw.candidatesTokenCount ??
          raw.outputTokens ??
          0
      ) + Number(raw.thoughtsTokenCount || 0);
    const total =
      Number(raw.totalTokenCount ?? raw.totalTokens ?? 0) || input + output;
    return { inputTokens: input, outputTokens: output, totalTokens: total };
  }

  // Claude CLI result.usage
  const input =
    Number(raw.input_tokens ?? raw.inputTokens ?? 0) +
    Number(raw.cache_creation_input_tokens || 0) +
    Number(raw.cache_read_input_tokens || 0);
  const output = Number(raw.output_tokens ?? raw.outputTokens ?? 0);
  const total =
    Number(raw.totalTokens ?? 0) ||
    input + output ||
    Number(raw.input_tokens || 0) + Number(raw.output_tokens || 0);
  return {
    inputTokens: Number(raw.input_tokens ?? raw.inputTokens ?? input) || input,
    outputTokens: output,
    totalTokens: total || input + output,
  };
}

/**
 * Append one usage row. Never throws to callers (logs and returns null on failure).
 * @returns {object|null} written entry
 */
export function appendTokenUsage(entry, { filePath, env = process.env } = {}) {
  try {
    const provider = String(entry.provider || 'claude').toLowerCase();
    const usage = normalizeUsage(provider, {
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      totalTokens: entry.totalTokens,
      input_tokens: entry.input_tokens,
      output_tokens: entry.output_tokens,
      promptTokenCount: entry.promptTokenCount,
      candidatesTokenCount: entry.candidatesTokenCount,
      totalTokenCount: entry.totalTokenCount,
      thoughtsTokenCount: entry.thoughtsTokenCount,
      ...(entry.usage && typeof entry.usage === 'object' ? entry.usage : {}),
    });

    const row = {
      timestamp: entry.timestamp || new Date().toISOString(),
      runId: entry.runId || randomUUID(),
      provider,
      model: String(entry.model || ''),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens || usage.inputTokens + usage.outputTokens,
      estimatedCostUsd: estimateCostUsd({
        provider,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        estimatedCostUsd: entry.estimatedCostUsd ?? entry.costUsd,
      }),
      durationMs: Number(entry.durationMs || 0) || 0,
      source: String(entry.source || 'unknown'),
    };

    if (langfuseClient) {
      try {
        const trace = langfuseClient.trace({
          id: row.runId,
          name: row.source,
          sessionId: row.runId,
          tags: [row.provider, row.model || 'unknown'],
          input: entry.taskText,
          output: entry.outputText,
        });

        trace.generation({
          name: "agent-execution",
          model: row.model || row.provider,
          input: entry.taskText,
          output: entry.outputText,
          usage: {
            input: row.inputTokens,
            output: row.outputTokens,
            total: row.totalTokens
          },
          startTime: new Date(Date.now() - row.durationMs),
          endTime: new Date(),
        });
        langfuseClient.flushAsync().catch(() => {});
      } catch (err) {
        console.warn('[token-logger] Langfuse trace failed:', err.message);
      }
    }

    const logPath = filePath || defaultLogPath(env);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `${JSON.stringify(row)}\n`, 'utf8');
    return row;
  } catch (err) {
    console.warn('[token-logger] append failed:', err.message);
    return null;
  }
}

/**
 * @param {string} [filePath]
 * @returns {object[]}
 */
export function readTokenUsageLog(filePath = defaultLogPath()) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const text = fs.readFileSync(filePath, 'utf8');
    const rows = [];
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        rows.push(JSON.parse(trimmed));
      } catch {
        /* skip corrupt */
      }
    }
    return rows;
  } catch {
    return [];
  }
}

function periodBounds(period, now = Date.now()) {
  const end = now;
  const p = String(period || 'day').toLowerCase();
  if (p === 'all') return { start: 0, end, label: 'all' };
  if (p === 'week') {
    return { start: end - 7 * 24 * 60 * 60 * 1000, end, label: 'week' };
  }
  return { start: end - 24 * 60 * 60 * 1000, end, label: 'day' };
}

function emptyProviderBucket() {
  return {
    runs: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: 0,
    durationMs: 0,
  };
}

/**
 * @param {object} [opts]
 * @param {'day'|'week'|'all'} [opts.period]
 * @param {string} [opts.filePath]
 * @param {number} [opts.now]
 */
export function summarizeTokenUsage({
  period = 'day',
  filePath,
  now = Date.now(),
  env = process.env,
} = {}) {
  const logPath = filePath || defaultLogPath(env);
  const { start, end, label } = periodBounds(period, now);
  const rows = readTokenUsageLog(logPath).filter((r) => {
    const t = Date.parse(r.timestamp || '');
    return Number.isFinite(t) && t >= start && t <= end;
  });

  const byProvider = {
    claude: emptyProviderBucket(),
    gemini: emptyProviderBucket(),
    cursor: emptyProviderBucket(),
  };

  for (const r of rows) {
    const key = ['claude', 'gemini', 'cursor'].includes(r.provider)
      ? r.provider
      : 'claude';
    const b = byProvider[key];
    b.runs += 1;
    b.inputTokens += Number(r.inputTokens) || 0;
    b.outputTokens += Number(r.outputTokens) || 0;
    b.totalTokens += Number(r.totalTokens) || 0;
    b.estimatedCostUsd = roundUsd(
      b.estimatedCostUsd + (Number(r.estimatedCostUsd) || 0)
    );
    b.durationMs += Number(r.durationMs) || 0;
  }

  const totals = emptyProviderBucket();
  for (const b of Object.values(byProvider)) {
    totals.runs += b.runs;
    totals.inputTokens += b.inputTokens;
    totals.outputTokens += b.outputTokens;
    totals.totalTokens += b.totalTokens;
    totals.estimatedCostUsd = roundUsd(
      totals.estimatedCostUsd + b.estimatedCostUsd
    );
    totals.durationMs += b.durationMs;
  }

  return {
    period: label,
    since: start ? new Date(start).toISOString() : null,
    until: new Date(end).toISOString(),
    totals,
    byProvider,
    runs: rows.length,
  };
}
