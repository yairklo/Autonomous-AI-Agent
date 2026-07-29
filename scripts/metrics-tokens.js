#!/usr/bin/env node
/**
 * Print token usage summary.
 *
 *   npm run metrics:tokens
 *   npm run metrics:tokens -- --period week
 *   npm run metrics:tokens -- --period all
 */

import { summarizeTokenUsage } from '../server/metrics/token-logger.js';

const args = process.argv.slice(2);
let period = 'day';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--period' && args[i + 1]) {
    period = args[i + 1];
    i++;
  }
}

const s = summarizeTokenUsage({ period });
console.log(`Token usage (${s.period})`);
console.log(`  since: ${s.since || '—'}`);
console.log(`  until: ${s.until}`);
console.log(`  runs:  ${s.totals.runs}`);
console.log(
  `  tokens: in=${s.totals.inputTokens} out=${s.totals.outputTokens} total=${s.totals.totalTokens}`
);
console.log(`  est. cost USD: ${s.totals.estimatedCostUsd}`);
console.log(`  durationMs: ${s.totals.durationMs}`);
console.log('By provider:');
for (const [name, b] of Object.entries(s.byProvider)) {
  if (!b.runs) continue;
  console.log(
    `  ${name}: runs=${b.runs} tokens=${b.totalTokens} costUsd=${b.estimatedCostUsd} durationMs=${b.durationMs}`
  );
}
