import assert from 'node:assert';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ClaudeSessionManager from '../server/claude-session.js';
import { config } from '../server/config.js';
import {
  detectCodingDispatch,
  detectWhatsappCvSubmit,
  detectWhatsappJobScan,
  isInteractiveConversationRequest,
  isShortDispatchConfirmation,
  wantsExplicitDispatch,
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
import { submitWhatsappJobCv } from '../server/cv-submitter.js';
import {
  extractApplyContacts,
  parseWhatsappExport,
  scanWhatsappJobs,
  scoreJobMessage,
} from '../server/whatsapp-job-scanner.js';
import { containsHebrew, formatBidi } from './format-bidi.js';

test('formatBidi leaves English/Hebrew logical by default (no double-flip)', () => {
  assert.strictEqual(formatBidi('Hello agent'), 'Hello agent');
  assert.strictEqual(containsHebrew('Hello agent'), false);

  const he = 'שלום עולם';
  assert.ok(containsHebrew(he));
  // Default: logical order (Windows Terminal already applies BiDi).
  assert.strictEqual(formatBidi(he), he);

  const fenced = 'intro\n```js\nconst x = 1;\n```\nסוף';
  const out = formatBidi(fenced);
  assert.ok(out.includes('```js\nconst x = 1;\n```'), 'code fence must stay intact');
  assert.ok(out.startsWith('intro\n'));
  assert.ok(out.includes('סוף'));
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
  assert.match(config.systemPrompt, /happen HERE with the user/i);
  assert.match(config.systemPrompt, /never send Grill-Me/i);
  assert.match(config.systemPrompt, /DOMAIN PACK: WhatsApp jobs \+ CV/i);
  assert.match(config.systemPrompt, /human approval before send/i);
  assert.doesNotMatch(config.systemPrompt, /Bash tool/i);
});

test('Grill-Me Pack / שאל אותי stays conversational — no Cursor or CV auto-tool', () => {
  const t =
    'שאל אותי את השאלות מתוך ה-Grill-Me Pack של WhatsApp והגשת קורות חיים.';
  assert.ok(isInteractiveConversationRequest(t));
  assert.strictEqual(wantsSkipGrillMe(t), false);
  assert.strictEqual(wantsExplicitDispatch(t), false);
  assert.strictEqual(detectCodingDispatch(t), null);
  assert.strictEqual(detectCodingDispatch(t, { interactiveChat: true }), null);
  assert.strictEqual(
    detectWhatsappCvSubmit(t),
    null,
    'must not auto-submit CV while asking Grill-Me questions'
  );
  assert.strictEqual(detectGrillMePack(t), PACK_WHATSAPP_JOBS_CV);
  assert.ok(isWhatsAppJobsGrillMeRequest(t));
});

test('dispatch_coding_task only on explicit trigger phrases', () => {
  for (const phrase of [
    'dispatch',
    'confirm dispatch',
    'skip Grill-Me',
    'שגר',
    'בצע',
    'skip Grill-Me Mode and dispatch to Cursor',
  ]) {
    assert.ok(wantsExplicitDispatch(phrase), `should trigger: ${phrase}`);
  }
  assert.strictEqual(wantsExplicitDispatch('שאל אותי שאלות'), false);
  assert.strictEqual(
    detectCodingDispatch('Add a logout button please', { interactiveChat: true }),
    null,
    'interactive chat must not auto-dispatch without trigger'
  );
  const d = detectCodingDispatch('שגר ל-Cursor: implement logout', {
    interactiveChat: true,
  });
  assert.ok(d);
  assert.strictEqual(d.mcpTool, 'dispatch_coding_task');
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

test('formatGrillMeReply returns Hebrew questionnaire with opening + full bank', () => {
  const reply = formatGrillMeReply(PACK_WHATSAPP_JOBS_CV, {
    locale: 'he',
    openingLimit: 5,
  });
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
      'שאל אותי את השאלות מתוך ה-Grill-Me Pack של WhatsApp והגשת קורות חיים.';
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
  assert.ok(result.jobs.some((j) => j.contacts?.emails?.length > 0));
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

test('extractApplyContacts finds emails in job posts', () => {
  const contacts = extractApplyContacts(
    'דרוש Full Stack. שלחו קו"ח ל-jobs@example.com או https://jobs.example.com/apply'
  );
  assert.deepStrictEqual(contacts.emails, ['jobs@example.com']);
  assert.ok(contacts.urls.some((u) => /jobs\.example\.com/.test(u)));
});

test('MCP tools - submit_whatsapp_job_cv registration', () => {
  const tools = listMcpTools();
  assert.ok(tools.some((t) => t.name === 'submit_whatsapp_job_cv'));
  const tool = getMcpTool('submit_whatsapp_job_cv');
  assert.ok(tool);
  assert.match(tool.description, /CV|mailto|draft/i);
  assert.ok(tool.inputSchema.properties.jobText);
  assert.ok(tool.inputSchema.properties.confirm);
});

test('System prompt documents submit_whatsapp_job_cv', () => {
  assert.match(config.systemPrompt, /submit_whatsapp_job_cv/);
  assert.match(config.systemPrompt, /mailto/i);
});

test('submitWhatsappJobCv drafts package with mailto', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-apps-'));
  try {
    const result = submitWhatsappJobCv({
      jobId: 'test-job-1',
      jobText:
        "We're hiring a Backend Engineer. Send resume to mike@acme.dev",
      groupName: 'Jobs Israel',
      author: 'Recruiter Mike',
      profilePath: config.cvFixtureProfilePath,
      applicationsDir: dir,
    });
    assert.ok(result.ok);
    assert.strictEqual(result.application.status, 'draft');
    assert.ok(result.application.mailto?.startsWith('mailto:'));
    assert.ok(result.application.contacts.emails.includes('mike@acme.dev'));
    assert.ok(fs.existsSync(result.files.json));
    assert.ok(fs.existsSync(result.files.cover));
    assert.ok(fs.existsSync(result.files.cv));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('detectWhatsappCvSubmit matches Hebrew/English apply requests', () => {
  const he = detectWhatsappCvSubmit('הגש קו״ח למשרה מ-WhatsApp');
  assert.ok(he);
  assert.strictEqual(he.mcpTool, 'submit_whatsapp_job_cv');
  assert.strictEqual(he.resolveFromScan, true);

  const en = detectWhatsappCvSubmit('Submit CV to jobs@example.com');
  assert.ok(en);
  assert.strictEqual(en.mcpArgs.recipientEmail, 'jobs@example.com');
  assert.strictEqual(en.resolveFromScan, false);
});

test('detectWhatsappCvSubmit ignores tool-implementation requests', () => {
  assert.strictEqual(
    detectWhatsappCvSubmit(
      'אני רוצה להוסיף לסוכן שלנו כלי לסריקת משרות בקבוצות WhatsApp והגשת קורות חיים'
    ),
    null
  );
});

test('executeMcpTool submit_whatsapp_job_cv uses fixture profile', async () => {
  const logs = [];
  const result = await executeMcpTool(
    'submit_whatsapp_job_cv',
    {
      jobText: 'דרוש Full Stack. שלחו קו"ח ל-jobs@example.com',
      groupName: 'Jobs Israel',
      author: 'Dana HR',
      profilePath: config.cvFixtureProfilePath,
      cvPath: path.join(config.root, 'assets', 'cv.pdf'),
    },
    { onLog: (line) => logs.push(line) }
  );
  assert.ok(result.ok);
  assert.strictEqual(result.tool, 'submit_whatsapp_job_cv');
  assert.strictEqual(result.application.status, 'draft');
  assert.ok(result.usedFixtureProfile);
  assert.match(logs.join('\n'), /\[mcp\] tool=submit_whatsapp_job_cv/);
  assert.match(logs.join('\n'), /status=ok/);
  try {
    if (result.files?.json) fs.unlinkSync(result.files.json);
    if (result.files?.cover) fs.unlinkSync(result.files.cover);
    if (result.files?.cv) fs.unlinkSync(result.files.cv);
  } catch {
    /* ignore */
  }
});

test('jobs config.json allow-lists WhatsApp groups only', async () => {
  const { loadJobsConfig, isAllowedGroup } = await import('../server/jobs/jobs-config.js');
  const cfg = loadJobsConfig(path.join(config.root, 'config.json'));
  assert.ok(cfg.whatsapp.groups.includes('Jobs Israel'));
  assert.ok(isAllowedGroup('Jobs Israel', cfg));
  assert.strictEqual(isAllowedGroup('Random Spam Group', cfg), false);
  assert.ok(cfg.safety.neverSendWhatsappGroupMessages);
  assert.ok(cfg.safety.neverSubmitWithoutTelegramApproval);
});

test('saveWhatsappGroups writes override used by loadJobsConfig', async () => {
  const {
    loadJobsConfig,
    saveWhatsappGroups,
    normalizeGroupNames,
  } = await import('../server/jobs/jobs-config.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-groups-'));
  const cfgPath = path.join(tmp, 'config.json');
  const overridePath = path.join(tmp, 'data', 'whatsapp-groups.json');
  try {
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        whatsapp: { groups: ['Jobs Israel'], textOnly: true, neverSendMessages: true },
        roles: ['Backend'],
        safety: {
          neverSendWhatsappGroupMessages: true,
          neverSubmitWithoutTelegramApproval: true,
        },
      }),
      'utf8'
    );
    const saved = saveWhatsappGroups(['My Custom Jobs', '  My Custom Jobs  ', 'Backend IL'], {
      overridePath,
    });
    assert.deepStrictEqual(saved.groups, ['My Custom Jobs', 'Backend IL']);
    assert.ok(fs.existsSync(overridePath));

    const cfg = loadJobsConfig(cfgPath);
    assert.deepStrictEqual(cfg.whatsapp.groups, ['My Custom Jobs', 'Backend IL']);
    assert.strictEqual(cfg.groupsSource, 'override');
    assert.deepStrictEqual(
      normalizeGroupNames(['a', 'A', '', 'b']),
      ['a', 'b']
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('connect-whatsapp script exists and documents QR login', () => {
  const script = path.join(config.root, 'scripts', 'connect-whatsapp.js');
  assert.ok(fs.existsSync(script));
  const src = fs.readFileSync(script, 'utf8');
  assert.match(src, /qrcode-terminal/);
  assert.match(src, /LocalAuth/);
  assert.match(src, /\.wwebjs_auth/);
});

test('matchFullStackOrBackend detects HE/EN roles', async () => {
  const { matchFullStackOrBackend } = await import('../server/jobs/job-matcher.js');
  const he = matchFullStackOrBackend('דרוש Full Stack Developer עם Node');
  assert.ok(he.matches);
  assert.ok(he.rolesMatched.length > 0);
  const en = matchFullStackOrBackend("We're hiring a Backend Engineer");
  assert.ok(en.matches);
  const pm = matchFullStackOrBackend('משרה חדשה: Product Manager');
  assert.strictEqual(pm.matches, false);
});

test('JobDb dedupes by fingerprint', async () => {
  const { JobDb } = await import('../server/jobs/job-db.js');
  const dbPath = path.join(os.tmpdir(), `jobs-db-${Date.now()}.json`);
  try {
    const db = new JobDb(dbPath);
    const a = db.upsertJob({
      text: 'Hiring Backend Engineer apply https://x.test/a',
      groupName: 'Jobs Israel',
      author: 'Mike',
      contacts: { emails: [], phones: [], urls: ['https://x.test/a'] },
    });
    assert.ok(a.isNew);
    const b = db.upsertJob({
      text: 'Hiring Backend Engineer apply https://x.test/a',
      groupName: 'Jobs Israel',
      author: 'Mike',
      contacts: { emails: [], phones: [], urls: ['https://x.test/a'] },
    });
    assert.strictEqual(b.isNew, false);
    assert.strictEqual(b.job.id, a.job.id);
  } finally {
    try {
      fs.unlinkSync(dbPath);
    } catch {
      /* ignore */
    }
  }
});

test('Telegram Approve/Reject callback parse + dry-run alert', async () => {
  const { createTelegramClient } = await import('../server/jobs/telegram.js');
  const tg = createTelegramClient({ botToken: '', chatId: '' });
  assert.deepStrictEqual(tg.parseApprovalCallback('job_approve:abc123'), {
    action: 'approve',
    jobId: 'abc123',
  });
  assert.deepStrictEqual(tg.parseApprovalCallback('job_reject:abc123'), {
    action: 'reject',
    jobId: 'abc123',
  });
  const sent = await tg.sendJobApprovalRequest(
    {
      id: 'abc123',
      groupName: 'Jobs Israel',
      author: 'Dana',
      rolesMatched: ['Full Stack'],
      formUrl: 'https://jobs.example.com/apply',
      snippet: 'דרוש Full Stack',
    },
    { dryRun: true }
  );
  assert.ok(sent.dryRun);
  assert.ok(sent.replyMarkup.inline_keyboard[0].some((b) => b.text === 'Approve'));
  assert.ok(sent.replyMarkup.inline_keyboard[0].some((b) => b.text === 'Reject'));
});

test('Playwright submit refuses without approval', async () => {
  const { submitJobFormWithPlaywright } = await import(
    '../server/jobs/playwright-submitter.js'
  );
  await assert.rejects(
    () =>
      submitJobFormWithPlaywright({
        formUrl: 'https://jobs.example.com/apply',
        profile: { name: 'Demo' },
        cvPath: path.join(config.root, 'assets', 'cv.pdf'),
        coverLetter: 'hi',
        approved: false,
        dryRun: true,
      }),
    /approval|Approve/i
  );
});

test('pipeline scan → approve → playwright dry-run', async () => {
  const {
    scanAndEnqueueJobs,
    resolveJobApproval,
    submitApprovedJob,
  } = await import('../server/jobs/pipeline.js');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-pipe-'));
  const dbPath = path.join(tmp, 'jobs-db.json');
  const appsDir = path.join(tmp, 'apps');
  const cfgPath = path.join(tmp, 'config.json');
  const base = JSON.parse(
    fs.readFileSync(path.join(config.root, 'config.json'), 'utf8')
  );
  base.storage.jobsDbPath = dbPath;
  base.storage.applicationsDir = appsDir;
  base.profile.path = config.cvFixtureProfilePath;
  base.profile.cvPath = path.join(config.root, 'assets', 'cv.pdf');
  fs.writeFileSync(cfgPath, JSON.stringify(base, null, 2), 'utf8');

  try {
    const scanned = await scanAndEnqueueJobs({
      configPath: cfgPath,
      exportPath: config.whatsappFixturePath,
      notifyTelegram: true,
      dryRunTelegram: true,
      limit: 10,
    });
    assert.ok(scanned.enqueuedCount >= 1, 'expected Full Stack/Backend jobs');
    assert.ok(scanned.jobs.every((j) => j.formUrl || j.contacts?.urls?.length));

    const jobId = scanned.jobs[0].id;
    const approved = resolveJobApproval({
      configPath: cfgPath,
      callbackData: `job_approve:${jobId}`,
    });
    assert.strictEqual(approved.job.approvalStatus, 'approved');

    const submitted = await submitApprovedJob({
      configPath: cfgPath,
      jobId,
      dryRun: true,
      skipDelay: true,
    });
    assert.ok(submitted.ok);
    assert.strictEqual(submitted.application.whatsappSend, false);
    assert.strictEqual(submitted.application.channel, 'playwright_forms_only');
    assert.ok(fs.existsSync(submitted.files.json));

    await assert.rejects(
      () =>
        submitApprovedJob({
          configPath: cfgPath,
          jobId: scanned.jobs[1]?.id || 'missing',
          dryRun: true,
          skipDelay: true,
        }),
      (err) =>
        err.code === 'SUBMIT_NOT_APPROVED' ||
        err.code === 'JOB_NOT_FOUND' ||
        /not Telegram-approved|not found/i.test(err.message)
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('MCP tools register Telegram + Playwright pipeline tools', () => {
  const names = listMcpTools().map((t) => t.name);
  for (const n of [
    'start_whatsapp_job_watcher',
    'request_job_telegram_approval',
    'resolve_job_approval',
    'submit_job_form',
  ]) {
    assert.ok(names.includes(n), `missing MCP tool ${n}`);
  }
});

test('executeMcpTool scan_whatsapp_jobs pipeline=true', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-mcp-'));
  const cfgPath = path.join(tmp, 'config.json');
  const base = JSON.parse(
    fs.readFileSync(path.join(config.root, 'config.json'), 'utf8')
  );
  base.storage.jobsDbPath = path.join(tmp, 'db.json');
  base.storage.applicationsDir = path.join(tmp, 'apps');
  fs.writeFileSync(cfgPath, JSON.stringify(base, null, 2), 'utf8');
  const logs = [];
  try {
    const result = await executeMcpTool(
      'scan_whatsapp_jobs',
      {
        pipeline: true,
        configPath: cfgPath,
        exportPath: config.whatsappFixturePath,
        limit: 5,
      },
      { onLog: (line) => logs.push(line) }
    );
    assert.ok(result.ok);
    assert.strictEqual(result.pipeline, true);
    assert.ok(result.enqueuedCount >= 1);
    assert.match(logs.join('\n'), /pipeline=true/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('whatsapp live analyzer respects config groups and blocks sends', async () => {
  const { analyzeRealtimeMessage, startWhatsappJobWatcher } = await import(
    '../server/jobs/whatsapp-live.js'
  );
  const { loadJobsConfig } = await import('../server/jobs/jobs-config.js');
  const cfg = loadJobsConfig(path.join(config.root, 'config.json'));
  const ok = analyzeRealtimeMessage(
    {
      groupName: 'Jobs Israel',
      body: 'דרוש Backend Engineer https://jobs.example.com/b',
    },
    cfg
  );
  assert.ok(ok.accepted);
  const blocked = analyzeRealtimeMessage(
    { groupName: 'Not Allowed', body: 'Hiring Backend https://x.test' },
    cfg
  );
  assert.strictEqual(blocked.accepted, false);

  const fake = {
    on() {},
    async initialize() {},
    async destroy() {},
    async sendMessage() {
      return 'should-be-replaced';
    },
  };
  await startWhatsappJobWatcher({
    jobsConfig: cfg,
    client: fake,
    onJob: async () => {},
  });
  await assert.rejects(() => fake.sendMessage('x', 'hi'), /never send|Blocked/i);
});

test('System prompt documents Playwright + Telegram approval pipeline', () => {
  assert.match(config.systemPrompt, /Playwright/i);
  assert.match(config.systemPrompt, /Telegram/i);
  assert.match(config.systemPrompt, /config\.json/);
  assert.match(config.systemPrompt, /submit_job_form/);
  assert.match(config.systemPrompt, /assets\/cv\.pdf/);
});

test('buildSpecMarkdown no longer all-TBD after approval', async () => {
  const { buildSpecMarkdown, PACK_WHATSAPP_JOBS_CV } = await import(
    '../server/grill-me-packs.js'
  );
  const spec = buildSpecMarkdown(PACK_WHATSAPP_JOBS_CV, { locale: 'he' });
  // Pack builder still templates TBD placeholders; approved answers live in specs/*.md
  assert.match(spec, /primary-goal/);
  const approved = fs.readFileSync(
    path.join(config.root, 'specs', 'whatsapp-jobs-cv-grill-me.md'),
    'utf8'
  );
  assert.match(approved, /whatsapp-web\.js/);
  assert.match(approved, /Playwright/);
  assert.doesNotMatch(approved, /\*\*A:\*\* _TBD_/);
});

test('resolveVoiceAgentBaseUrl prefers VOICE_AGENT_URL over Compose-style defaults', async () => {
  const { resolveVoiceAgentBaseUrl } = await import(
    '../server/joinup-telegram/voice-agent-url.js'
  );
  assert.strictEqual(
    resolveVoiceAgentBaseUrl({
      VOICE_AGENT_URL: 'https://agent.example.com/',
      JOINUP_RUN_LOG_URL: 'http://ignored:9',
      PORT: '9999',
    }),
    'https://agent.example.com'
  );
  assert.strictEqual(
    resolveVoiceAgentBaseUrl({
      JOINUP_RUN_LOG_URL: 'http://app:8787/',
      PORT: '9999',
    }),
    'http://app:8787'
  );
  assert.strictEqual(
    resolveVoiceAgentBaseUrl({
      JOINUP_RUN_LOG_HOST: 'voice-agent',
      VOICE_AGENT_PORT: '8787',
      PORT: '3000',
    }),
    'http://voice-agent:8787'
  );
  assert.strictEqual(resolveVoiceAgentBaseUrl({}), 'http://127.0.0.1:8787');
});
