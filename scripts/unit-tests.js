import assert from 'node:assert';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ClaudeSessionManager from '../server/claude-session.js';
import { config } from '../server/config.js';
import { detectCodingDispatch } from '../server/task-router.js';
import { executeMcpTool, getMcpTool, listMcpTools } from '../server/mcp-tools.js';

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

test('MCP tools - dispatch_coding_task registration', () => {
  const tools = listMcpTools();
  assert.ok(tools.some((t) => t.name === 'dispatch_coding_task'));
  const tool = getMcpTool('dispatch_coding_task');
  assert.ok(tool);
  assert.match(
    tool.description,
    /Dispatches a software development\/coding task to Cursor Agent CLI in headless mode/
  );
  assert.deepStrictEqual(tool.inputSchema.required, ['projectPath', 'taskDescription']);
  assert.ok(tool.inputSchema.properties.projectPath);
  assert.ok(tool.inputSchema.properties.taskDescription);
});

test('System prompt forbids raw shell/file edits; mandates MCP tool', () => {
  assert.match(config.systemPrompt, /ZERO capability/i);
  assert.match(config.systemPrompt, /dispatch_coding_task/);
  assert.match(config.systemPrompt, /MUST be executed solely/i);
  assert.doesNotMatch(config.systemPrompt, /Bash tool/i);
});

test('detectCodingDispatch returns MCP tool args', () => {
  const d = detectCodingDispatch(
    'Implement a focused MCP tool and skip Grill-Me Mode; dispatch to Cursor for C:/Autonomous AI Agent'
  );
  assert.ok(d);
  assert.strictEqual(d.mcpTool, 'dispatch_coding_task');
  assert.ok(d.mcpArgs.projectPath);
  assert.ok(d.mcpArgs.taskDescription);
  assert.match(d.mcpArgs.taskDescription, /MCP tool/i);
});

test('executeMcpTool dispatch_coding_task invokes dispatch-task.js', async () => {
  const stubPath = path.join(os.tmpdir(), `stub-dispatch-${Date.now()}.mjs`);
  fs.writeFileSync(
    stubPath,
    [
      'const args = process.argv.slice(2);',
      'console.log("[dispatch] stub node scripts/dispatch-task.js " + args.join(" "));',
      'console.log("✓ Written prompt instructions to: PROMPT.md");',
      'console.log("$ cursor agent -p --force --trust (stub)");',
      'process.exit(0);',
      '',
    ].join('\n'),
    'utf8'
  );

  const prev = process.env.DISPATCH_TASK_SCRIPT;
  process.env.DISPATCH_TASK_SCRIPT = stubPath;
  const logs = [];
  try {
    const result = await executeMcpTool(
      'dispatch_coding_task',
      {
        projectPath: config.root,
        taskDescription: 'unit-test coding task via MCP',
      },
      { onLog: (line) => logs.push(line) }
    );
    assert.ok(result.ok);
    assert.strictEqual(result.tool, 'dispatch_coding_task');
    assert.match(logs.join('\n'), /\[mcp\] tool=dispatch_coding_task/);
    assert.match(logs.join('\n'), /dispatch-task\.js|\[dispatch\] node/i);
    assert.match(logs.join('\n'), /status=ok/);
  } finally {
    if (prev === undefined) delete process.env.DISPATCH_TASK_SCRIPT;
    else process.env.DISPATCH_TASK_SCRIPT = prev;
    try {
      fs.unlinkSync(stubPath);
    } catch {
      /* ignore */
    }
  }
});
