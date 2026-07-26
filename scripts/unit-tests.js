import assert from 'node:assert';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ClaudeSessionManager from '../server/claude-session.js';
import { config } from '../server/config.js';
import {
  detectCodingDispatch,
  detectWhatsappJobScan,
  isShortDispatchConfirmation,
  wantsSkipGrillMe,
} from '../server/task-router.js';
import { executeMcpTool, getMcpTool, listMcpTools } from '../server/mcp-tools.js';
import {
  parseWhatsappExport,
  scanWhatsappJobs,
  scoreJobMessage,
} from '../server/whatsapp-job-scanner.js';

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

test('System prompt forbids raw shell/file edits; mandates MCP tool + Grill-Me', () => {
  assert.match(config.systemPrompt, /ZERO capability/i);
  assert.match(config.systemPrompt, /dispatch_coding_task/);
  assert.match(config.systemPrompt, /MUST be executed solely/i);
  assert.match(config.systemPrompt, /GRILL-ME MODE/i);
  assert.match(config.systemPrompt, /skip Grill-Me Mode/i);
  assert.match(config.systemPrompt, /candidate profile structure/i);
  assert.match(config.systemPrompt, /approval workflows/i);
  assert.doesNotMatch(config.systemPrompt, /Bash tool/i);
});

test('Grill-Me: ordinary coding request does NOT auto-dispatch', () => {
  const d = detectCodingDispatch(
    'Add a logout button to the Header in project C:/Autonomous AI Agent'
  );
  assert.strictEqual(d, null, 'should stay in Grill-Me Mode (no skip signal)');
  assert.strictEqual(wantsSkipGrillMe('Add a logout button please'), false);
});

test('detectCodingDispatch returns MCP tool args only when skip Grill-Me / dispatch', () => {
  const d = detectCodingDispatch(
    'Implement a focused MCP tool and skip Grill-Me Mode; dispatch to Cursor for C:/Autonomous AI Agent'
  );
  assert.ok(d);
  assert.strictEqual(d.mcpTool, 'dispatch_coding_task');
  assert.strictEqual(d.skipGrillMe, true);
  assert.ok(d.mcpArgs.projectPath);
  assert.ok(d.mcpArgs.taskDescription);
  assert.match(d.mcpArgs.taskDescription, /MCP tool/i);
  assert.strictEqual(d.shortConfirmation, false);
});

test('Hebrew skip Grill-Me + שגר triggers dispatch detection', () => {
  const d = detectCodingDispatch(
    'תוסיף כפתור יציאה. דלג על Grill-Me Mode ושגר את המשימה ישירות ל-Cursor.'
  );
  assert.ok(d);
  assert.strictEqual(d.mcpTool, 'dispatch_coding_task');
  assert.ok(wantsSkipGrillMe(d.task));
});

test('Short dispatch confirmation is flagged for session refine', () => {
  assert.ok(isShortDispatchConfirmation('skip Grill-Me Mode and dispatch to Cursor'));
  assert.ok(isShortDispatchConfirmation('שגר ל-Cursor'));
  assert.strictEqual(
    isShortDispatchConfirmation(
      'Implement logout button and skip Grill-Me Mode; dispatch to Cursor for C:/Autonomous AI Agent'
    ),
    false
  );
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

test('MCP tools - scan_whatsapp_jobs registration', () => {
  const tools = listMcpTools();
  assert.ok(tools.some((t) => t.name === 'scan_whatsapp_jobs'));
  const tool = getMcpTool('scan_whatsapp_jobs');
  assert.ok(tool);
  assert.match(tool.description, /WhatsApp/i);
  assert.ok(tool.inputSchema.properties.exportPath);
  assert.ok(tool.inputSchema.properties.roles);
});

test('System prompt documents scan_whatsapp_jobs', () => {
  assert.match(config.systemPrompt, /scan_whatsapp_jobs/);
  assert.match(config.systemPrompt, /WhatsApp/i);
});

test('parseWhatsappExport + scoreJobMessage detect HE/EN jobs', () => {
  const fixture = path.join(
    config.root,
    'fixtures',
    'whatsapp',
    'WhatsApp Chat with Jobs Israel.txt'
  );
  const raw = fs.readFileSync(fixture, 'utf8');
  const messages = parseWhatsappExport(raw, { groupName: 'Jobs Israel' });
  assert.ok(messages.length >= 5);
  const scored = messages.map((m) => ({
    ...m,
    ...scoreJobMessage(m.body),
  }));
  const jobs = scored.filter((m) => m.isJob);
  assert.ok(jobs.length >= 3, `expected >=3 jobs, got ${jobs.length}`);
  assert.ok(jobs.some((j) => /Full Stack|דרוש/i.test(j.body)));
  assert.ok(jobs.some((j) => /hiring|Backend/i.test(j.body)));
});

test('scanWhatsappJobs reads fixture export', () => {
  const result = scanWhatsappJobs({
    exportPath: config.whatsappFixturePath,
    roles: ['Full Stack', 'DevOps'],
    limit: 10,
  });
  assert.ok(result.ok);
  assert.ok(result.jobCount >= 3);
  assert.ok(result.jobs.every((j) => j.matchedSignals.length > 0));
  assert.ok(result.jobs.some((j) => j.matchedSignals.some((s) => /role:/i.test(s))));
});

test('detectWhatsappJobScan matches Hebrew/English scan requests', () => {
  const he = detectWhatsappJobScan('תסרוק משרות בקבוצות WhatsApp');
  assert.ok(he);
  assert.strictEqual(he.mcpTool, 'scan_whatsapp_jobs');

  const en = detectWhatsappJobScan('Scan WhatsApp groups for jobs');
  assert.ok(en);
  assert.strictEqual(en.mcpTool, 'scan_whatsapp_jobs');
});

test('detectWhatsappJobScan ignores tool-implementation requests', () => {
  assert.strictEqual(
    detectWhatsappJobScan(
      'אני רוצה להוסיף לסוכן שלנו כלי לסריקת משרות בקבוצות WhatsApp'
    ),
    null
  );
  assert.strictEqual(
    detectWhatsappJobScan('Implement a WhatsApp jobs scanning MCP tool'),
    null
  );
});

test('executeMcpTool scan_whatsapp_jobs uses fixture when exports empty', async () => {
  const logs = [];
  const result = await executeMcpTool(
    'scan_whatsapp_jobs',
    { exportPath: config.whatsappExportsDir, limit: 10 },
    { onLog: (line) => logs.push(line) }
  );
  assert.ok(result.ok);
  assert.strictEqual(result.tool, 'scan_whatsapp_jobs');
  assert.ok(result.jobCount >= 3);
  assert.match(logs.join('\n'), /\[mcp\] tool=scan_whatsapp_jobs/);
  assert.match(logs.join('\n'), /status=ok/);
});
