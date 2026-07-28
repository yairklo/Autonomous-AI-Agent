import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  appendTokenUsage,
  estimateCostUsd,
  normalizeUsage,
  summarizeTokenUsage,
} from '../server/metrics/token-logger.js';

test('normalizeUsage maps Claude and Gemini shapes', () => {
  const claude = normalizeUsage('claude', {
    input_tokens: 100,
    output_tokens: 50,
  });
  assert.equal(claude.inputTokens, 100);
  assert.equal(claude.outputTokens, 50);
  assert.equal(claude.totalTokens, 150);

  const gemini = normalizeUsage('gemini', {
    promptTokenCount: 200,
    candidatesTokenCount: 80,
    totalTokenCount: 280,
  });
  assert.equal(gemini.inputTokens, 200);
  assert.equal(gemini.outputTokens, 80);
  assert.equal(gemini.totalTokens, 280);
});

test('estimateCostUsd uses rate table and prefers explicit cost', () => {
  const fromTable = estimateCostUsd({
    provider: 'claude',
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
  });
  assert.equal(fromTable, 18); // 3 + 15

  const gemini = estimateCostUsd({
    provider: 'gemini',
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
  });
  assert.equal(gemini, 0.5); // 0.1 + 0.4

  assert.equal(
    estimateCostUsd({
      provider: 'claude',
      inputTokens: 1,
      outputTokens: 1,
      estimatedCostUsd: 0.123456,
    }),
    0.123456
  );
});

test('append + summarize day/week', () => {
  const filePath = path.join(
    os.tmpdir(),
    `token-usage-test-${Date.now()}.jsonl`
  );
  const now = Date.parse('2026-07-28T12:00:00.000Z');

  appendTokenUsage(
    {
      timestamp: '2026-07-28T11:00:00.000Z',
      provider: 'gemini',
      model: 'gemini-3.6-flash',
      inputTokens: 100,
      outputTokens: 40,
      durationMs: 1200,
      source: 'web_chat',
      runId: 'r1',
    },
    { filePath }
  );
  appendTokenUsage(
    {
      timestamp: '2026-07-28T11:30:00.000Z',
      provider: 'claude',
      model: 'claude-cli',
      usage: { input_tokens: 50, output_tokens: 25 },
      estimatedCostUsd: 0.01,
      durationMs: 800,
      source: 'telegram',
      runId: 'r2',
    },
    { filePath }
  );
  appendTokenUsage(
    {
      timestamp: '2026-07-22T11:00:00.000Z',
      provider: 'cursor',
      model: 'cursor-agent',
      durationMs: 5000,
      source: 'mcp_dispatch',
      runId: 'r3',
    },
    { filePath }
  );

  const day = summarizeTokenUsage({ period: 'day', filePath, now });
  assert.equal(day.totals.runs, 2);
  assert.equal(day.byProvider.gemini.runs, 1);
  assert.equal(day.byProvider.claude.runs, 1);
  assert.equal(day.byProvider.cursor.runs, 0);
  assert.ok(day.totals.totalTokens >= 215);

  const week = summarizeTokenUsage({ period: 'week', filePath, now });
  assert.equal(week.totals.runs, 3);
  assert.equal(week.byProvider.cursor.runs, 1);

  const all = summarizeTokenUsage({ period: 'all', filePath, now });
  assert.equal(all.totals.runs, 3);

  try {
    fs.unlinkSync(filePath);
  } catch {
    /* ignore */
  }
});

console.log('token-logger tests: ok');
