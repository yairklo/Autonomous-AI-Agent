import { spawn } from 'node:child_process';
import fs from 'node:fs';
import assert from 'node:assert';
import { execSync } from 'node:child_process';

const args = process.argv.slice(2);
let userPrompt = '';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--prompt' && args[i + 1]) {
    userPrompt = args[i + 1];
    i++;
  }
}

const promptText =
  userPrompt ||
  'תוסיף כפתור יציאה (logout) בראש העמוד (Header) בפרויקט C:/Autonomous AI Agent. דלג על Grill-Me Mode ושגר את המשימה ישירות ל-Cursor.';
console.log(`--- Starting E2E Task Dispatch Test ---`);
console.log(`Prompt to send: "${promptText}"`);
console.log(`DISPATCH_AGENT=${process.env.DISPATCH_AGENT || '(unset)'}`);

const promptFile = 'C:/Autonomous AI Agent/PROMPT.md';
const rulesFile = 'C:/Autonomous AI Agent/.cursorrules';
const runLogFile = 'C:/Autonomous AI Agent/DISPATCH_RUN.log';
const gitDir = 'C:/Autonomous AI Agent';

let initialCommit = '';
let initialBranch = '';
try {
  initialCommit = execSync('git rev-parse HEAD', { cwd: gitDir }).toString().trim();
  initialBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: gitDir }).toString().trim();
  console.log(`✓ Initial git state: branch=${initialBranch}, commit=${initialCommit}`);
} catch (e) {
  console.error('Failed to get initial git state:', e.message);
}

for (const f of [promptFile, rulesFile, runLogFile, 'C:/Autonomous AI Agent/DISPATCH_RESULT.md']) {
  if (fs.existsSync(f)) {
    fs.unlinkSync(f);
    console.log(`✓ Cleaned up existing ${f}`);
  }
}

let userPath = '';
let machinePath = '';
try {
  userPath = execSync(
    '[Environment]::GetEnvironmentVariable("Path", "User")',
    { shell: 'powershell.exe' }
  )
    .toString()
    .trim();
  machinePath = execSync(
    '[Environment]::GetEnvironmentVariable("Path", "Machine")',
    { shell: 'powershell.exe' }
  )
    .toString()
    .trim();
} catch {
  /* ignore */
}
const fullPath = userPath && machinePath ? `${userPath};${machinePath}` : process.env.PATH;

const collectedLogs = [];
function noteLog(line) {
  collectedLogs.push(line);
}

console.log('Starting server...');
const server = spawn('node', ['server/index.js'], {
  cwd: 'c:/Autonomous AI Agent',
  env: {
    ...process.env,
    PATH: fullPath,
    WHISPER_BIN: 'whisper',
    AUTO_DISPATCH_CODING: '1',
    DISPATCH_AGENT: process.env.DISPATCH_AGENT || 'cursor',
    DISPATCH_AGENT_TIMEOUT_MS: process.env.DISPATCH_AGENT_TIMEOUT_MS || '600000',
  },
});

server.stdout.on('data', (c) => {
  const logStr = c.toString().trim();
  if (logStr) {
    console.log(`[server] ${logStr}`);
    noteLog(logStr);
  }
});
server.stderr.on('data', (c) => {
  const logStr = c.toString().trim();
  if (logStr) {
    console.error(`[server:err] ${logStr}`);
    noteLog(logStr);
  }
});

await new Promise((r) => setTimeout(r, 3000));

let success = false;
let createdBranch = null;
try {
  console.log('Sending chat request to server...');
  const res = await fetch('http://127.0.0.1:8787/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientId: 'e2e-dispatch-test-client-' + Date.now(),
      text: promptText,
    }),
  });

  if (!res.ok) throw new Error(`Server returned HTTP ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let split;
    while ((split = buffer.indexOf('\n\n')) >= 0) {
      const chunk = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      const lines = chunk.split('\n');
      let event = 'message';
      let data = '';
      for (const line of lines) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (!data) continue;
      try {
        const payload = JSON.parse(data);
        if (event === 'token' && payload.text) {
          process.stdout.write(payload.text);
          noteLog(payload.text);
        }
        if (event === 'error' && payload.error) throw new Error(payload.error);
      } catch (err) {
        if (err instanceof SyntaxError) continue;
        throw err;
      }
    }
  }

  console.log('\n✓ SSE Stream completed.');
  const allLogs = collectedLogs.join('\n');

  const promptWritten =
    fs.existsSync(promptFile) || /Written prompt instructions to:.*PROMPT\.md/i.test(allLogs);
  const rulesWritten =
    fs.existsSync(rulesFile) || /Written Cursor rules to:.*\.cursorrules/i.test(allLogs);
  assert.ok(promptWritten, 'PROMPT.md was not generated');
  assert.ok(rulesWritten, '.cursorrules was not generated');
  console.log('✓ PROMPT.md / .cursorrules write verified.');

  const content = fs.existsSync(promptFile) ? fs.readFileSync(promptFile, 'utf8') : allLogs;
  const rulesContent = fs.existsSync(rulesFile) ? fs.readFileSync(rulesFile, 'utf8') : allLogs;
  if (fs.existsSync(promptFile)) {
    console.log('--- PROMPT.md Content ---\n' + content + '\n-------------------------');
  }
  if (fs.existsSync(rulesFile)) {
    console.log('--- .cursorrules Content ---\n' + rulesContent + '\n-------------------------');
  }

  assert.ok(
    /git checkout -b feature\//i.test(content) || /git checkout -b feature\//i.test(allLogs),
    'PROMPT.md missing branch instruction'
  );
  assert.ok(
    /non-interactive|auto-approve/i.test(content) || /non-interactive|auto-approve/i.test(allLogs),
    'PROMPT.md missing auto-approve instruction'
  );
  assert.ok(
    (/commit/i.test(content) && /push/i.test(content)) ||
      (/commit/i.test(allLogs) && /push/i.test(allLogs)),
    'PROMPT.md missing commit/push instruction'
  );
  assert.ok(/PROMPT\.md/i.test(rulesContent) || /PROMPT\.md/i.test(allLogs), '.cursorrules missing PROMPT.md ref');
  console.log('✓ PROMPT.md and .cursorrules assertions passed successfully.');

  let runLog = '';
  if (fs.existsSync(runLogFile)) {
    runLog = fs.readFileSync(runLogFile, 'utf8');
    console.log('--- DISPATCH_RUN.log ---\n' + runLog + '\n-------------------------');
  }

  const cursorInvoked =
    /\$\s*cursor(\s+agent|\-agent)?\b/i.test(allLogs) ||
    /\$\s*cursor(\s+agent|\-agent)?\b/i.test(runLog) ||
    /executor=cursor/i.test(runLog) ||
    /engine=cursor/i.test(allLogs) ||
    /engine=cursor/i.test(runLog);
  assert.ok(cursorInvoked, 'Strict check failed: `cursor` was not invoked for task execution');
  console.log('✓ Strict check: Cursor executable was invoked for task execution.');

  const claudeUsedAsRunner =
    /\$\s*claude(\.cmd|\.exe)?\s+(-p|--print)\b/i.test(allLogs) ||
    /engine=claude\b/i.test(allLogs) ||
    /Headless agent finished \(engine=claude/i.test(allLogs) ||
    /executor=claude\b/i.test(runLog) ||
    /Falling back to local deterministic agent/i.test(allLogs);
  assert.ok(!claudeUsedAsRunner, 'Strict check failed: `claude` was used as the code runner');
  console.log('✓ Strict check: Claude was NOT used as the code runner.');

  const finalCommit = execSync('git rev-parse HEAD', { cwd: gitDir }).toString().trim();
  const finalBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: gitDir }).toString().trim();
  createdBranch = finalBranch;
  console.log(`✓ Final git state: branch=${finalBranch}, commit=${finalCommit}`);
  assert.ok(
    finalBranch !== initialBranch || finalCommit !== initialCommit,
    'No new git branch or commit was created by the headless Cursor agent'
  );
  console.log('✓ Git branch/commit assertion passed successfully.');

  success = true;
} catch (err) {
  console.error('❌ E2E Test Failed:', err.message);
} finally {
  console.log('Stopping server...');
  try {
    server.kill();
  } catch {
    /* ignore */
  }

  console.log('✓ Kept PROMPT.md and .cursorrules for manual/visual verification.');

  try {
    if (initialBranch) {
      console.log(`Switching Git branch back to: ${initialBranch}...`);
      execSync(`git checkout --force ${initialBranch}`, { cwd: gitDir, stdio: 'inherit' });
    }
  } catch (err) {
    console.error('Failed to restore git branch:', err.message);
  }

  if (success) {
    console.log('\n✓ E2E Task Dispatch Assertion Passed!');
    process.exit(0);
  } else {
    process.exit(1);
  }
}
