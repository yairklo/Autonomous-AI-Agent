import assert from 'node:assert';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ClaudeSessionManager from '../server/claude-session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

test('Header includes a wired Logout button', () => {
  const html = fs.readFileSync(path.join(root, 'client', 'index.html'), 'utf8');
  const appJs = fs.readFileSync(path.join(root, 'client', 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'client', 'styles.css'), 'utf8');

  assert.match(html, /<header\s+class="top">/);
  assert.match(html, /id="logoutBtn"/);
  assert.match(html, />\s*Logout\s*</);
  assert.match(html, /class="top-actions"/);
  assert.match(css, /\.top-actions\s*\{/);
  assert.match(appJs, /logoutBtn:\s*document\.getElementById\('logoutBtn'\)/);
  assert.match(appJs, /els\.logoutBtn\.addEventListener\('click'/);
  assert.match(appJs, /\/api\/session\/reset/);
});

test('ClaudeSessionManager - parseStreamLine', async (t) => {
  const sessionsFile = './test-sessions.json';
  const manager = new ClaudeSessionManager({ mock: true, sessionsFile });
  
  try {
    await t.test('session get/reset/save workflow', () => {
      const clientId = 'test-client';
      assert.strictEqual(manager.getSession(clientId), null);
      
      // Simulate setting a session ID
      manager.sessions.set(clientId, { sessionId: 'xyz', updatedAt: new Date().toISOString() });
      manager._save();
      
      const retrieved = manager.getSession(clientId);
      assert.ok(retrieved);
      assert.strictEqual(retrieved.sessionId, 'xyz');
      
      manager.reset(clientId);
      assert.strictEqual(manager.getSession(clientId), null);
    });
  } finally {
    try { fs.unlinkSync(sessionsFile); } catch {}
  }
});

test('ClaudeSessionManager - Ask (mock mode)', async (t) => {
  const sessionsFile = './test-sessions-mock.json';
  const manager = new ClaudeSessionManager({ mock: true, sessionsFile });
  try {
    const events = [];
    for await (const event of manager.ask('client-1', 'hello')) {
      events.push(event);
    }

    assert.ok(events.length > 0, 'Should yield events');
    const sessionEvent = events.find(e => e.type === 'session');
    assert.ok(sessionEvent, 'Should yield a session event');
    assert.ok(sessionEvent.sessionId, 'Session event should have a sessionId');
    
    const doneEvent = events.find(e => e.type === 'done');
    assert.ok(doneEvent, 'Should yield a done event');
    assert.ok(doneEvent.result.includes('mock voice-agent reply'), 'Result should match mock reply');
  } finally {
    try { fs.unlinkSync(sessionsFile); } catch {}
  }
});
