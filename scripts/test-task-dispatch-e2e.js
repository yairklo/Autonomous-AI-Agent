import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
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

const promptText = userPrompt || 'תוסיף כפתור יציאה (logout) בראש העמוד (Header) בפרויקט C:/Autonomous AI Agent. דלג על Grill-Me Mode ושגר את המשימה ישירות ל-Cursor.';
console.log(`--- Starting E2E Task Dispatch Test ---`);
console.log(`Prompt to send: "${promptText}"`);

const promptFile = 'C:/Autonomous AI Agent/PROMPT.md';
const rulesFile = 'C:/Autonomous AI Agent/.cursorrules';
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

// 1. Clean up any existing files
if (fs.existsSync(promptFile)) {
  fs.unlinkSync(promptFile);
  console.log('✓ Cleaned up existing PROMPT.md');
}
if (fs.existsSync(rulesFile)) {
  fs.unlinkSync(rulesFile);
  console.log('✓ Cleaned up existing .cursorrules');
}

// 2. Load system path for subprocesses
let userPath = '';
let machinePath = '';
try {
  userPath = execSync('[Environment]::GetEnvironmentVariable("Path", "User")', { shell: 'powershell.exe' }).toString().trim();
  machinePath = execSync('[Environment]::GetEnvironmentVariable("Path", "Machine")', { shell: 'powershell.exe' }).toString().trim();
} catch (e) {
  // fallback
}
const fullPath = userPath && machinePath ? `${userPath};${machinePath}` : process.env.PATH;

// 3. Start the server on port 8787
console.log('Starting server...');
const server = spawn('node', ['server/index.js'], {
  cwd: 'c:/Autonomous AI Agent',
  env: {
    ...process.env,
    PATH: fullPath,
    WHISPER_BIN: 'whisper'
  }
});

server.stdout.on('data', (c) => {
  const logStr = c.toString();
  if (logStr.includes('[STT Log]') || logStr.includes('[Server stdout]')) {
    console.log(logStr.trim());
  }
});

// Wait for server to boot
await new Promise((r) => setTimeout(r, 3000));

let success = false;
try {
  // 4. Send request to /api/chat
  console.log('Sending chat request to server...');
  const res = await fetch('http://127.0.0.1:8787/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientId: 'e2e-dispatch-test-client-' + Date.now(),
      text: promptText
    })
  });

  if (!res.ok) {
    throw new Error(`Server returned HTTP ${res.status}`);
  }

  // Read response stream
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullReply = '';

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
          fullReply += payload.text;
          process.stdout.write(payload.text);
        }
      } catch {
        // ignore
      }
    }
  }

  console.log('\n✓ SSE Stream completed.');
  console.log('Verifying generated PROMPT.md file...');

  // 5. Assertions on generated files
  assert.ok(fs.existsSync(promptFile), 'PROMPT.md was not generated in the target directory');
  console.log('✓ PROMPT.md exists.');

  assert.ok(fs.existsSync(rulesFile), '.cursorrules was not generated in the target directory');
  console.log('✓ .cursorrules exists.');

  const content = fs.readFileSync(promptFile, 'utf8');
  console.log('--- PROMPT.md Content ---');
  console.log(content);
  console.log('-------------------------');

  const rulesContent = fs.readFileSync(rulesFile, 'utf8');
  console.log('--- .cursorrules Content ---');
  console.log(rulesContent);
  console.log('-------------------------');

  assert.ok(content.includes('git checkout -b feature/'), 'PROMPT.md does not contain branch checkout instruction');
  assert.ok(content.includes('non-interactive') || content.includes('auto-approve'), 'PROMPT.md does not contain auto-approve instruction');
  assert.ok(content.includes('commit') && content.includes('push'), 'PROMPT.md does not contain commit/push verification instruction');
  assert.ok(rulesContent.includes('PROMPT.md'), '.cursorrules does not instruct reading PROMPT.md');
  console.log('✓ PROMPT.md and .cursorrules assertions passed successfully.');

  // Verify git state changed (headless agent created branch/commit)
  const finalCommit = execSync('git rev-parse HEAD', { cwd: gitDir }).toString().trim();
  const finalBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: gitDir }).toString().trim();
  console.log(`✓ Final git state: branch=${finalBranch}, commit=${finalCommit}`);

  assert.ok(finalBranch !== initialBranch || finalCommit !== initialCommit, 'No new git branch or commit was created by the headless agent');
  console.log('✓ Git branch/commit assertion passed successfully.');

  success = true;
} catch (err) {
  console.error('❌ E2E Test Failed:', err.message);
} finally {
  console.log('Stopping server...');
  server.kill();

  // Do NOT clean up PROMPT.md and .cursorrules so user can verify Cursor opened them!
  console.log('✓ Kept PROMPT.md and .cursorrules for manual/visual verification.');

  // Reset Git branch/state to initial
  try {
    if (initialBranch) {
      console.log(`Resetting Git branch back to: ${initialBranch}...`);
      execSync(`git checkout ${initialBranch}`, { cwd: gitDir });
      execSync('git reset --hard HEAD', { cwd: gitDir });
      execSync('git clean -fd', { cwd: gitDir });
    }
  } catch (err) {
    console.error('Failed to reset git branch:', err.message);
  }

  if (success) {
    console.log('\n✓ E2E Task Dispatch Assertion Passed!');
    process.exit(0);
  } else {
    process.exit(1);
  }
}
