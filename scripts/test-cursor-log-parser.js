import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyCursorLogLine } from '../server/cursor-log-parser.js';

test('classifies cursor/dispatch lines', () => {
  assert.equal(classifyCursorLogLine('[dispatch] node script.js').type, 'status');
  assert.equal(classifyCursorLogLine('$ cursor-agent -p --force').type, 'tool');
  assert.equal(classifyCursorLogLine('git checkout -b feature/task-1').type, 'git');
  assert.equal(classifyCursorLogLine('✗ Cursor agent failed').type, 'error');
  assert.equal(classifyCursorLogLine('I will update the API next.').type, 'thinking');
  assert.equal(classifyCursorLogLine('✓ Written prompt instructions').type, 'status');
});

console.log('cursor-log-parser tests: ok');
