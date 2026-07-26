import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  buildQualityGateInstructions,
  detectQualityGates,
} from './dispatch-quality-gates.js';

test('detectQualityGates finds next_app build and server test', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qg-'));
  fs.mkdirSync(path.join(root, 'next_app'));
  fs.writeFileSync(
    path.join(root, 'next_app', 'package.json'),
    JSON.stringify({ scripts: { build: 'next build' } })
  );
  fs.mkdirSync(path.join(root, 'server'));
  fs.writeFileSync(
    path.join(root, 'server', 'package.json'),
    JSON.stringify({ scripts: { test: 'jest' } })
  );

  const gates = detectQualityGates(root);
  assert.ok(gates.some((g) => g.id === 'next_app:typecheck'));
  assert.ok(gates.some((g) => g.id === 'next_app:build'));
  assert.ok(gates.some((g) => g.id === 'server:test'));
});

test('buildQualityGateInstructions requires build loop and Dev merge', () => {
  const text = buildQualityGateInstructions({ mergeTarget: 'Dev', maxFixLoops: 3 });
  assert.match(text, /npm run build/i);
  assert.match(text, /Fix loop/i);
  assert.match(text, /Dev/);
  assert.match(text, /Vercel/i);
});

console.log('dispatch quality gates tests: ok');
