import fs from 'node:fs';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

loadDotEnv(path.join(repoRoot, '.env'));

const args = process.argv.slice(2);
let projectPath = '';
let taskDescription = '';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--project' && args[i + 1]) {
    projectPath = args[i + 1];
    i++;
  } else if (args[i] === '--task' && args[i + 1]) {
    taskDescription = args[i + 1];
    i++;
  }
}

if (!projectPath || !taskDescription) {
  console.error('Usage: node scripts/dispatch-task.js --project <path> --task <description>');
  process.exit(1);
}

const resolvedPath = path.resolve(projectPath);
const branchName = `feature/task-${Date.now()}`;
const requestedMode = (process.env.DISPATCH_AGENT || 'cursor').toLowerCase();
const agentTimeoutMs = Number(process.env.DISPATCH_AGENT_TIMEOUT_MS || 600000);

if (!fs.existsSync(resolvedPath)) {
  fs.mkdirSync(resolvedPath, { recursive: true });
}

if (requestedMode === 'claude' || requestedMode === 'local' || requestedMode === 'local-fallback') {
  console.warn(
    `[dispatch] DISPATCH_AGENT=${requestedMode} is not allowed for code execution (Claude/local cannot edit code). Using Cursor Agent CLI.`
  );
}

const promptContent = `# Cursor Task Execution Instruction

## Task Description
${taskDescription}

## Strict Instructions for Cursor / Antigravity Agent
1. **Branching:** Create and switch to a new feature branch before editing code:
   \`git checkout -b ${branchName}\`
2. **Autonomy:** Run in non-interactive/auto-approve mode. Do NOT prompt for permission on file edits or terminal commands.
3. **Verification & Completion:**
   - Execute tests/validations to confirm correct behavior.
   - Stage all changes, commit them with a clean descriptive message, and push the branch to the remote origin.
4. **Do not delete PROMPT.md or .cursorrules** until after commit (E2E verifies them).
`;

const promptPath = path.join(resolvedPath, 'PROMPT.md');
fs.writeFileSync(promptPath, promptContent, 'utf8');
console.log(`✓ Written prompt instructions to: ${promptPath}`);

const cursorrulesContent = `# Cursor Agent Rules
- You MUST read the instructions in PROMPT.md immediately.
- Create and switch to a new git branch before editing code: \`git checkout -b ${branchName}\` (or as specified in PROMPT.md).
- Run in non-interactive/auto-approve mode to execute the task fully. Do NOT prompt for permission on file edits or terminal commands.
- Run tests/validations, commit changes with a clean message, and push the branch to remote upon completion.
- Do not open a GUI. Work entirely via terminal/CLI tools.
- Keep PROMPT.md and .cursorrules in the repo after finishing.
`;
const cursorrulesPath = path.join(resolvedPath, '.cursorrules');
fs.writeFileSync(cursorrulesPath, cursorrulesContent, 'utf8');
console.log(`✓ Written Cursor rules to: ${cursorrulesPath}`);

const before = captureGit(resolvedPath);
console.log(`✓ Pre-agent git: branch=${before.branch} commit=${before.commit}`);

const agentPrompt = [
  'Read PROMPT.md and .cursorrules in this workspace.',
  'Execute the task fully and autonomously in non-interactive mode.',
  `Create and use branch ${branchName} (or the branch named in PROMPT.md).`,
  'Implement the required code changes, run tests if available (npm test),',
  'then git add, commit, and push the branch (push best-effort if remote denies).',
  'Do not ask questions. Do not open a GUI.',
  'Do not delete PROMPT.md or .cursorrules.',
  `Task summary: ${taskDescription}`,
].join(' ');

const runLogPath = path.join(resolvedPath, 'DISPATCH_RUN.log');

// Dry-run path for MCP-layer e2e: still exercises dispatch-task.js + git, without nesting Cursor.
if (process.env.DISPATCH_DRY_RUN === '1') {
  console.log(`Running headless Cursor agent in: ${resolvedPath}`);
  console.log(`✓ Cursor executor resolved: cursor agent (dry-run)`);
  console.log(`$ cursor agent -p --force --trust --workspace ${resolvedPath} <prompt-from-PROMPT.md>`);
  fs.writeFileSync(
    runLogPath,
    [
      `executor=cursor agent`,
      `bin=cursor`,
      `startedAt=${new Date().toISOString()}`,
      `requestedMode=${requestedMode}`,
      `dryRun=1`,
    ].join('\n') + '\n',
    'utf8'
  );
  try {
    execSync(`git checkout -b ${branchName}`, { cwd: resolvedPath, stdio: 'inherit' });
  } catch {
    execSync(`git checkout ${branchName}`, { cwd: resolvedPath, stdio: 'inherit' });
  }
  execSync('git add PROMPT.md .cursorrules', { cwd: resolvedPath, stdio: 'inherit' });
  try {
    execSync(`git commit -m "chore: dry-run dispatch for MCP e2e (${branchName})"`, {
      cwd: resolvedPath,
      stdio: 'inherit',
    });
  } catch {
    execSync(`git commit --allow-empty -m "chore: dry-run dispatch for MCP e2e (${branchName})"`, {
      cwd: resolvedPath,
      stdio: 'inherit',
    });
  }
  const afterDry = captureGit(resolvedPath);
  console.log(`✓ Post-agent git: branch=${afterDry.branch} commit=${afterDry.commit}`);
  console.log('✓ Headless agent finished (engine=cursor).');
  fs.appendFileSync(
    runLogPath,
    `finishedAt=${new Date().toISOString()}\nengine=cursor\nbranch=${afterDry.branch}\ncommit=${afterDry.commit}\n`,
    'utf8'
  );
  console.log('✓ Headless Cursor agent execution completed successfully!');
  process.exit(0);
}

const cursorLaunch = resolveCursorLaunch();
console.log(`Running headless Cursor agent in: ${resolvedPath}`);
console.log(`✓ Cursor executor resolved: ${cursorLaunch.display}`);

fs.writeFileSync(
  runLogPath,
  [
    `executor=${cursorLaunch.display}`,
    `bin=${cursorLaunch.bin}`,
    `args=${JSON.stringify(cursorLaunch.buildArgs(agentPrompt, resolvedPath))}`,
    `startedAt=${new Date().toISOString()}`,
    `requestedMode=${requestedMode}`,
  ].join('\n') + '\n',
  'utf8'
);

try {
  await runCursorAgent(cursorLaunch, resolvedPath, agentPrompt);
} catch (err) {
  console.error(`✗ Cursor agent failed: ${err.message}`);
  console.error(
    '✗ Refusing Claude/local fallback — separation of duties requires Cursor to execute code.'
  );
  fs.appendFileSync(runLogPath, `error=${err.message}\n`, 'utf8');
  process.exit(1);
}

// Re-assert prompt files exist for E2E (Cursor sometimes removes them).
if (!fs.existsSync(promptPath)) fs.writeFileSync(promptPath, promptContent, 'utf8');
if (!fs.existsSync(cursorrulesPath)) fs.writeFileSync(cursorrulesPath, cursorrulesContent, 'utf8');

const after = captureGit(resolvedPath);
console.log(`✓ Post-agent git: branch=${after.branch} commit=${after.commit}`);
console.log('✓ Headless agent finished (engine=cursor).');
fs.appendFileSync(
  runLogPath,
  `finishedAt=${new Date().toISOString()}\nengine=cursor\nbranch=${after.branch}\ncommit=${after.commit}\n`,
  'utf8'
);

if (after.branch === before.branch && after.commit === before.commit) {
  console.error('✗ Cursor agent produced no new git branch or commit.');
  process.exit(1);
}

console.log('✓ Headless Cursor agent execution completed successfully!');

function resolveCursorLaunch() {
  const override = process.env.CURSOR_BIN?.trim();
  const localDir = path.join(process.env.LOCALAPPDATA || '', 'cursor-agent');
  const localAgentPs1 = path.join(localDir, 'cursor-agent.ps1');
  const localAgentCmd = path.join(localDir, 'cursor-agent.cmd');
  const localAgent = path.join(localDir, 'agent.cmd');

  const candidates = [
    override,
    fs.existsSync(localAgentPs1) ? localAgentPs1 : null,
    'cursor-agent',
    fs.existsSync(localAgentCmd) ? localAgentCmd : null,
    fs.existsSync(localAgent) ? localAgent : null,
    'cursor',
  ].filter(Boolean);

  for (const bin of candidates) {
    const base = path.basename(bin).toLowerCase();
    if (base === 'claude' || base.startsWith('claude.')) continue;

    if (base === 'cursor' || base === 'cursor.cmd' || base === 'cursor.exe') {
      return {
        bin,
        display: 'cursor agent',
        kind: 'cursor-ide',
        buildArgs: (prompt, cwd) => [
          'agent',
          '-p',
          '--force',
          '--trust',
          '--workspace',
          cwd,
          prompt,
        ],
      };
    }

    if (base.endsWith('.ps1')) {
      return {
        bin,
        display: 'cursor-agent',
        kind: 'powershell',
        buildArgs: (prompt, cwd) => [
          '-p',
          '--force',
          '--trust',
          '--workspace',
          cwd,
          prompt,
        ],
      };
    }

    return {
      bin,
      display: 'cursor-agent',
      kind: 'cmd',
      buildArgs: (prompt, cwd) => [
        '-p',
        '--force',
        '--trust',
        '--workspace',
        cwd,
        prompt,
      ],
    };
  }

  throw new Error(
    'Cursor Agent CLI not found. Install with: irm https://cursor.com/install?win32=true | iex'
  );
}

async function runCursorAgent(launch, cwd, prompt) {
  const argv = launch.buildArgs(prompt, cwd);
  console.log(`$ cursor agent -p --force --trust --workspace ${cwd} <prompt-from-PROMPT.md>`);
  console.log(`$ ${launch.bin} ${summarizeArgs(argv)}`);
  await run(launch, argv, { cwd, timeoutMs: agentTimeoutMs });
}

function summarizeArgs(argv) {
  return argv
    .map((a, i) => {
      if (i === argv.length - 1 && a.length > 80) return JSON.stringify(`${a.slice(0, 60)}…`);
      return /\s/.test(a) ? JSON.stringify(a) : a;
    })
    .join(' ');
}

function captureGit(cwd) {
  try {
    return {
      branch: execSync('git rev-parse --abbrev-ref HEAD', { cwd, encoding: 'utf8' }).trim(),
      commit: execSync('git rev-parse HEAD', { cwd, encoding: 'utf8' }).trim(),
    };
  } catch {
    return { branch: '', commit: '' };
  }
}

function run(launch, argsList, { cwd, timeoutMs = agentTimeoutMs, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    let command;
    let spawnArgs;
    if (launch.kind === 'powershell') {
      command = 'powershell.exe';
      spawnArgs = [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        launch.bin,
        ...argsList,
      ];
    } else if (process.platform === 'win32' && /\.cmd$/i.test(launch.bin)) {
      command = process.env.ComSpec || 'cmd.exe';
      const quoted = [launch.bin, ...argsList].map(windowsQuote).join(' ');
      spawnArgs = ['/d', '/s', '/c', quoted];
    } else {
      command = launch.bin;
      spawnArgs = argsList;
    }

    console.log(`[spawn] ${command} ${spawnArgs.map(windowsQuote).join(' ')}`);
    const child = spawn(command, spawnArgs, {
      cwd,
      env: { ...env, DISPATCH_NO_CLAUDE: '1' },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsVerbatimArguments: launch.kind === 'cmd' || /\.cmd$/i.test(launch.bin),
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      reject(new Error(`Timed out after ${timeoutMs}ms: ${launch.display}`));
    }, timeoutMs);
    child.stdout.on('data', (c) => {
      const t = c.toString();
      stdout += t;
      process.stdout.write(t);
    });
    child.stderr.on('data', (c) => {
      const t = c.toString();
      stderr += t;
      process.stderr.write(t);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr, code });
      else {
        reject(
          new Error(`${launch.display} exited ${code}: ${(stderr || stdout).slice(-800)}`)
        );
      }
    });
  });
}

function windowsQuote(arg) {
  const s = String(arg);
  if (!/[ \t"]/g.test(s)) return s;
  return `"${s.replace(/"/g, '\\"')}"`;
}

function loadDotEnv(filePath) {
  try {
    if (!fs.existsSync(filePath)) return;
    const text = fs.readFileSync(filePath, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
  } catch {
    /* ignore */
  }
}
