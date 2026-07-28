#!/usr/bin/env node
/**
 * Lightweight Gemini model discovery.
 * Dynamically lists models available to GEMINI_API_KEY (no hardcoded model IDs).
 *
 * Usage:
 *   GEMINI_API_KEY=... node scripts/list-google-models.js
 *   node scripts/list-google-models.js   # also reads project-root .env if present
 *
 * Prefers @google/genai SDK; falls back to Generative Language REST listModels.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function loadDotEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined || process.env[key] === '') {
      process.env[key] = value;
    }
  }
}

loadDotEnvFile(path.join(root, '.env'));
loadDotEnvFile(path.join(root, '.env.local'));

const apiKey = String(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim();

function shortName(name) {
  return String(name || '')
    .replace(/^models\//, '')
    .trim();
}

function normalizeModel(raw) {
  const name = shortName(raw.name || raw.model || '');
  const methods =
    raw.supportedActions ||
    raw.supportedGenerationMethods ||
    raw.supported_generation_methods ||
    [];
  return {
    name,
    fullName: raw.name || (name ? `models/${name}` : ''),
    displayName: raw.displayName || raw.display_name || name,
    description: raw.description || '',
    version: raw.version || '',
    inputTokenLimit: raw.inputTokenLimit ?? raw.input_token_limit ?? null,
    outputTokenLimit: raw.outputTokenLimit ?? raw.output_token_limit ?? null,
    supportedMethods: Array.isArray(methods) ? methods.map(String) : [],
    raw,
  };
}

function canGenerateContent(model) {
  return model.supportedMethods.some((m) =>
    /generateContent|generateMessage|bidiGenerateContent/i.test(m)
  );
}

/**
 * Rank generateContent models for primary orchestration agent on free tier.
 * Prefer Flash / Flash-Lite over Pro; prefer newer numbered series; avoid embeddings/imagen/tts.
 */
function scoreForPrimaryAgent(model) {
  const id = model.name.toLowerCase();
  if (!canGenerateContent(model)) return -Infinity;
  if (/embed|imagen|veo|tts|aqa|gemma|robotics|computer-use|preview-tts|image|lyria|omni|audio|live|translate|deep-research|antigravity/i.test(id)) {
    return -1000;
  }

  let score = 0;
  if (/flash-lite/.test(id)) score += 40;
  else if (/flash/.test(id)) score += 55;
  else if (/pro/.test(id)) score += 20;
  else score += 10;

  // Prefer stable over experimental/preview when both exist.
  if (/preview|exp|experimental|thinking-exp/i.test(id)) score -= 15;
  if (/lite/.test(id) && /flash/.test(id)) score += 5; // higher RPM/RPD on free tier

  const series = id.match(/gemini-(\d+(?:\.\d+)?)/);
  if (series) score += Math.min(30, Number(series[1]) * 8);

  // Slight preference for higher context when known.
  if (model.inputTokenLimit) {
    score += Math.min(10, Math.log10(model.inputTokenLimit + 1));
  }

  return score;
}

async function listViaSdk() {
  const { GoogleGenAI } = await import('@google/genai');
  const ai = new GoogleGenAI({ apiKey });
  const models = [];
  const pager = await ai.models.list({ config: { pageSize: 100 } });
  for await (const model of pager) {
    models.push(normalizeModel(model));
  }
  return { source: '@google/genai models.list()', models };
}

async function listViaRest() {
  const models = [];
  let pageToken = '';
  do {
    const url = new URL('https://generativelanguage.googleapis.com/v1beta/models');
    url.searchParams.set('key', apiKey);
    url.searchParams.set('pageSize', '100');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const res = await fetch(url);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = body?.error?.message || res.statusText || `HTTP ${res.status}`;
      const err = new Error(`REST listModels failed: ${msg}`);
      err.status = res.status;
      err.body = body;
      throw err;
    }
    for (const m of body.models || []) {
      models.push(normalizeModel(m));
    }
    pageToken = body.nextPageToken || '';
  } while (pageToken);

  return {
    source: 'REST GET /v1beta/models',
    models,
  };
}

async function discover() {
  try {
    return await listViaSdk();
  } catch (sdkErr) {
    if (sdkErr?.code === 'ERR_MODULE_NOT_FOUND' || /Cannot find package '@google\/genai'/i.test(String(sdkErr))) {
      console.error('[list-google-models] @google/genai not installed — using REST fallback');
      return listViaRest();
    }
    console.error(
      `[list-google-models] SDK list failed (${sdkErr.message || sdkErr}); trying REST…`
    );
    return listViaRest();
  }
}

function printReport({ source, models }) {
  const sorted = [...models].sort((a, b) => a.name.localeCompare(b.name));
  const generate = sorted.filter(canGenerateContent);
  const ranked = [...generate].sort(
    (a, b) => scoreForPrimaryAgent(b) - scoreForPrimaryAgent(a)
  );
  const recommended = ranked[0] || null;

  console.log('=== Gemini model discovery ===');
  console.log(`Source: ${source}`);
  console.log(`Key present: yes (len=${apiKey.length})`);
  console.log(`Total models: ${sorted.length}`);
  console.log(`generateContent-capable: ${generate.length}`);
  console.log('');

  console.log('--- All available models ---');
  for (const m of sorted) {
    const methods = m.supportedMethods.length
      ? m.supportedMethods.join(', ')
      : '(none listed)';
    const tokens =
      m.inputTokenLimit != null
        ? ` in=${m.inputTokenLimit} out=${m.outputTokenLimit ?? '?'}`
        : '';
    console.log(`- ${m.name}${tokens}`);
    if (m.displayName && m.displayName !== m.name) {
      console.log(`    display: ${m.displayName}`);
    }
    console.log(`    methods: ${methods}`);
  }

  console.log('');
  console.log('--- Recommendation (primary orchestration agent, free-tier oriented) ---');
  if (!recommended) {
    console.log('No generateContent model discovered for this key.');
  } else {
    console.log(`Best suited (from live list): ${recommended.name}`);
    console.log(
      `Why: scored highest among generateContent models for Flash-class free-tier agent work`
    );
    console.log(
      `    (prefer Flash / Flash-Lite over Pro; prefer newer series; deprioritize preview/exp/embed/imagen)`
    );
    if (recommended.inputTokenLimit != null) {
      console.log(
        `    token limits: input=${recommended.inputTokenLimit} output=${recommended.outputTokenLimit ?? '?'}`
      );
    }
    console.log('Top 5 candidates:');
    for (const m of ranked.slice(0, 5)) {
      console.log(`  ${scoreForPrimaryAgent(m).toFixed(1).padStart(6)}  ${m.name}`);
    }
  }

  // Machine-readable summary for piping.
  const summary = {
    source,
    total: sorted.length,
    generateContentCount: generate.length,
    recommended: recommended?.name || null,
    models: sorted.map((m) => m.name),
  };
  console.log('');
  console.log('--- JSON summary ---');
  console.log(JSON.stringify(summary, null, 2));
}

async function main() {
  if (!apiKey) {
    console.error(
      'GEMINI_API_KEY (or GOOGLE_API_KEY) is not set.\n' +
        'Set it in the environment or in a project-root .env file, then re-run:\n' +
        '  node scripts/list-google-models.js'
    );
    process.exit(2);
  }

  try {
    const result = await discover();
    printReport(result);
  } catch (err) {
    console.error('[list-google-models] failed:', err.message || err);
    if (err.status) console.error('HTTP status:', err.status);
    if (err.body) console.error(JSON.stringify(err.body, null, 2));
    process.exit(1);
  }
}

main();
