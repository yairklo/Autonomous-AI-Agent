import assert from 'node:assert';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ClaudeSessionManager from '../server/claude-session.js';
import { config } from '../server/config.js';
import {
  detectCodingDispatch,
  isShortDispatchConfirmation,
  wantsSkipGrillMe,
} from '../server/task-router.js';
import { executeMcpTool, getMcpTool, listMcpTools } from '../server/mcp-tools.js';
import {
  buildSpecMarkdown,
  detectGrillMePack,
  formatGrillMeReply,
  getAllQuestions,
  getOpeningQuestions,
  isWhatsAppJobsGrillMeRequest,
  listGrillMePacks,
  PACK_WHATSAPP_JOBS_CV,
  WHATSAPP_JOBS_CV_PACK,
} from '../server/grill-me-packs.js';

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
  assert.match(config.systemPrompt, /WhatsApp jobs \+ CV/i);
  assert.match(config.systemPrompt, /human approval before send/i);
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

test('WhatsApp jobs/CV Grill-Me pack covers mandatory themes', () => {
  assert.ok(listGrillMePacks().some((p) => p.id === PACK_WHATSAPP_JOBS_CV));
  const cats = WHATSAPP_JOBS_CV_PACK.categories.map((c) => c.id);
  for (const id of [
    'scope-goals',
    'whatsapp-access',
    'job-matching',
    'candidate-profile',
    'submission-flow',
    'approval-workflow',
    'acceptance-privacy',
  ]) {
    assert.ok(cats.includes(id), `missing category ${id}`);
  }
  const all = getAllQuestions(PACK_WHATSAPP_JOBS_CV);
  assert.ok(all.length >= 20, 'full bank should be substantial for a perfect spec');
  const opening = getOpeningQuestions(PACK_WHATSAPP_JOBS_CV, { limit: 5 });
  assert.strictEqual(opening.length, 5);
  assert.ok(opening.some((q) => q.id === 'who-approves'));
  assert.ok(opening.some((q) => q.id === 'profile-fields'));
});

test('Hebrew WhatsApp jobs request detects Grill-Me pack (no auto-dispatch)', () => {
  const he =
    'אני רוצה להוסיף לסוכן שלנו כלי חדש לסריקת משרות בקבוצות WhatsApp והגשת קורות חיים. תפעיל מוד Grill-Me ותשאל אותי את כל השאלות שאתה צריך כדי לבנות לזה אפיון מושלם.';
  assert.strictEqual(isWhatsAppJobsGrillMeRequest(he), true);
  assert.strictEqual(detectGrillMePack(he), PACK_WHATSAPP_JOBS_CV);
  assert.strictEqual(detectCodingDispatch(he), null, 'must stay in Grill-Me (no skip)');
  assert.strictEqual(wantsSkipGrillMe(he), false);
});

test('formatGrillMeReply returns Hebrew questionnaire with opening + full bank', () => {
  const reply = formatGrillMeReply(PACK_WHATSAPP_JOBS_CV, { locale: 'he', openingLimit: 5 });
  assert.match(reply, /Grill-Me Mode/);
  assert.match(reply, /היקף ומטרות|גישה ל-WhatsApp|מבנה פרופיל|אישורי אדם/);
  assert.match(reply, /שגר ל-Cursor|skip Grill-Me Mode/);
  const spec = buildSpecMarkdown(PACK_WHATSAPP_JOBS_CV, { locale: 'he' });
  assert.match(spec, /_TBD_/);
  assert.match(spec, /primary-goal/);
  assert.match(spec, /wa-client/);
});

test('Mock ClaudeSessionManager returns WhatsApp Grill-Me pack for HE request', async () => {
  const sessionsFile = `./test-sessions-grillme-${Date.now()}.json`;
  const manager = new ClaudeSessionManager({ mock: true, sessionsFile });
  try {
    const prompt =
      'סריקת משרות בקבוצות WhatsApp והגשת קורות חיים — Grill-Me לאפיון מושלם';
    let result = '';
    for await (const event of manager.ask('grill-client', prompt)) {
      if (event.type === 'done') result = event.result || result;
    }
    assert.match(result, /Grill-Me Mode/);
    assert.match(result, /WhatsApp|וואטסאפ|קבוצות/);
    assert.match(result, /קורות חיים|פרופיל|אישור/);
  } finally {
    try {
      fs.unlinkSync(sessionsFile);
    } catch {
      /* ignore */
    }
  }
});
