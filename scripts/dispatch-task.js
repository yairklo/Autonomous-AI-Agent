import fs from 'node:fs';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  buildQualityGateInstructions,
  runQualityGates,
} from './dispatch-quality-gates.js';
import {
  appendAgentLesson,
  ensureProjectAgentMemory,
} from './ensure-project-agent-memory.js';

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
const agentTimeoutMs = Number(process.env.DISPATCH_AGENT_TIMEOUT_MS || 900000);
const maxFixLoops = Number(process.env.DISPATCH_MAX_FIX_LOOPS || 5);
const mergeTarget = resolveMergeTarget(resolvedPath);

if (!fs.existsSync(resolvedPath)) {
  fs.mkdirSync(resolvedPath, { recursive: true });
}

if (requestedMode === 'claude' || requestedMode === 'local' || requestedMode === 'local-fallback') {
  console.warn(
    `[dispatch] DISPATCH_AGENT=${requestedMode} is not allowed for code execution (Claude/local cannot edit code). Using Cursor Agent CLI.`
  );
}

const qualityInstructions = buildQualityGateInstructions({
  mergeTarget: mergeTarget || 'Dev',
  maxFixLoops,
});

const promptContent = `# Cursor Task Execution Instruction

## Task Description
${taskDescription}

## Strict Instructions for Cursor / Antigravity Agent
1. **Branching:** Create and switch to a new feature branch before editing code:
   \`git checkout -b ${branchName}\`
2. **Autonomy:** Run in non-interactive/auto-approve mode. Do NOT prompt for permission on file edits or terminal commands.
3. **Verification & Completion:**
   - Execute local quality gates (build/tests) and fix failures in a loop until green.
   - Stage all changes, commit them with a clean descriptive message, and push the branch to the remote origin.
   - ${mergeTarget ? `Merge into \`${mergeTarget}\` and push so deploy (e.g. Vercel) runs.` : 'Push the feature branch (no merge target configured).'}
4. **Do not delete PROMPT.md or .cursorrules** until after commit (E2E verifies them).

${qualityInstructions}
`;

const promptPath = path.join(resolvedPath, 'PROMPT.md');
fs.writeFileSync(promptPath, promptContent, 'utf8');
console.log(`✓ Written prompt instructions to: ${promptPath}`);

// Durable memory survives across tasks (do not wipe AGENTS.md / .cursor/rules).
ensureProjectAgentMemory(resolvedPath, { onLog: (l) => console.log(l) });

const cursorrulesContent = `# Cursor Agent Rules
- You MUST read PROMPT.md, AGENTS.md, and .cursor/rules/ immediately.
- Create and switch to a new git branch before editing code: \`git checkout -b ${branchName}\` (or as specified in PROMPT.md).
- Run in non-interactive/auto-approve mode to execute the task fully. Do NOT prompt for permission on file edits or terminal commands.
- ALWAYS run local quality gates (especially \`next_app\` \`npm run build\` when present) and fix failures in a loop before finishing.
- ${mergeTarget ? `After gates are green: merge into \`${mergeTarget}\` and push.` : 'Commit and push the feature branch when done.'}
- When you discover a new TypeScript/deploy bug, append a short lesson to AGENTS.md (and .cursor/rules if useful) so future terminal agents remember it.
- Do not open a GUI. Work entirely via terminal/CLI tools.
- Keep PROMPT.md, .cursorrules, AGENTS.md, and .cursor/rules after finishing.
`;
const cursorrulesPath = path.join(resolvedPath, '.cursorrules');
fs.writeFileSync(cursorrulesPath, cursorrulesContent, 'utf8');
console.log(`✓ Written Cursor rules to: ${cursorrulesPath}`);
console.log(`✓ Quality gates enabled; mergeTarget=${mergeTarget || '(none)'} maxFixLoops=${maxFixLoops}`);

const before = captureGit(resolvedPath);
console.log(`✓ Pre-agent git: branch=${before.branch} commit=${before.commit}`);

const agentPrompt = [
  'Read PROMPT.md, .cursorrules, AGENTS.md, and .cursor/rules/ in this workspace.',
  'Obey durable lessons in AGENTS.md / .cursor/rules (API generics, required props, local next build).',
  'Execute the task fully and autonomously in non-interactive mode.',
  `Create and use branch ${branchName} (or the branch named in PROMPT.md).`,
  'Implement the required code changes.',
  'MANDATORY: run local quality gates (next_app npm run build, server npm test, etc.),',
  'fix any failures, and re-run until green. Do not finish on a red build.',
  mergeTarget
    ? `After green: commit, push feature branch, merge into ${mergeTarget}, and push ${mergeTarget}.`
    : 'After green: commit and push the feature branch.',
  'Do not ask questions. Do not open a GUI.',
  'Do not delete PROMPT.md, .cursorrules, AGENTS.md, or .cursor/rules.',
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
  // Soft-continue into quality gates: agent may have committed before timeout.
  console.error(`✗ Cursor agent reported failure: ${err.message}`);
  fs.appendFileSync(runLogPath, `agentError=${err.message}\n`, 'utf8');
  console.warn(
    '[dispatch] Continuing to local quality-gate / fix loop (agent may have already committed).'
  );
}

// Re-assert prompt files exist for E2E (Cursor sometimes removes them).
if (!fs.existsSync(promptPath)) fs.writeFileSync(promptPath, promptContent, 'utf8');
if (!fs.existsSync(cursorrulesPath)) fs.writeFileSync(cursorrulesPath, cursorrulesContent, 'utf8');

let after = captureGit(resolvedPath);
console.log(`✓ Post-agent git: branch=${after.branch} commit=${after.commit}`);
console.log('✓ Headless agent finished (engine=cursor) — entering quality-gate loop.');

if (process.env.DISPATCH_SKIP_QUALITY_GATES !== '1') {
  const gateResult = await enforceQualityGatesWithFixLoop({
    cursorLaunch,
    projectRoot: resolvedPath,
    featureBranchHint: branchName,
    maxFixLoops,
    runLogPath,
  });
  if (!gateResult.ok) {
    console.error('✗ Quality gates still failing after fix loops.');
    fs.appendFileSync(
      runLogPath,
      `qualityGates=failed\nfailedGate=${gateResult.failedGate || ''}\n`,
      'utf8'
    );
    process.exit(1);
  }
  fs.appendFileSync(runLogPath, 'qualityGates=passed\n', 'utf8');
} else {
  console.warn('[dispatch] DISPATCH_SKIP_QUALITY_GATES=1 — skipping local gates');
}

after = captureGit(resolvedPath);

if (mergeTarget && process.env.DISPATCH_SKIP_MERGE !== '1') {
  try {
    mergeFeatureIntoTarget(resolvedPath, mergeTarget, after.branch || branchName);
    fs.appendFileSync(runLogPath, `mergedInto=${mergeTarget}\n`, 'utf8');
    console.log(`✓ Merged into ${mergeTarget} and pushed (deploy should start).`);
  } catch (err) {
    console.error(`✗ Merge into ${mergeTarget} failed: ${err.message}`);
    fs.appendFileSync(runLogPath, `mergeError=${err.message}\n`, 'utf8');
    process.exit(1);
  }
}

after = captureGit(resolvedPath);
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
  const linuxLocalAgent = path.join(
    process.env.HOME || '/root',
    '.local',
    'bin',
    'agent'
  );

  const candidates = [
    override,
    fs.existsSync(localAgentPs1) ? localAgentPs1 : null,
    fs.existsSync(linuxLocalAgent) ? linuxLocalAgent : null,
    'agent',
    'cursor-agent',
    fs.existsSync(localAgentCmd) ? localAgentCmd : null,
    fs.existsSync(localAgent) ? localAgent : null,
    'cursor',
  ].filter(Boolean);

  for (const bin of candidates) {
    const base = path.basename(bin).toLowerCase();
    if (base === 'claude' || base.startsWith('claude.')) continue;

    // Non-interactive / headless flags for Coolify + local Docker:
    //   -p / --print   print mode (no TTY chat)
    //   --force        auto-approve edits
    //   --trust        trust workspace without prompt
    const headlessArgs = (prompt, cwd) => [
      '-p',
      '--force',
      '--trust',
      '--workspace',
      cwd,
      prompt,
    ];

    if (base === 'cursor' || base === 'cursor.cmd' || base === 'cursor.exe') {
      return {
        bin,
        display: 'cursor agent',
        kind: 'cursor-ide',
        buildArgs: (prompt, cwd) => [
          'agent',
          ...headlessArgs(prompt, cwd),
        ],
      };
    }

    if (base.endsWith('.ps1')) {
      return {
        bin,
        display: 'cursor-agent',
        kind: 'powershell',
        buildArgs: headlessArgs,
      };
    }

    // Linux Coolify / Docker: `agent` binary from cursor.com/install
    if (base === 'agent' || base === 'cursor-agent') {
      return {
        bin,
        display: 'cursor-agent',
        kind: 'cmd',
        buildArgs: headlessArgs,
      };
    }

    return {
      bin,
      display: 'cursor-agent',
      kind: 'cmd',
      buildArgs: headlessArgs,
    };
  }

  throw new Error(
    'Cursor Agent CLI not found. Install with: curl https://cursor.com/install -fsS | bash  (Linux) or irm https://cursor.com/install?win32=true | iex (Windows). Then run: npm run auth:cli'
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

function summarizeGateFailureLesson(failedGate, errorTail) {
  const text = String(errorTail || '');
  if (/Property '(\w+)' does not exist on type '\{\}'/.test(text)) {
    const prop = text.match(/Property '(\w+)' does not exist on type '\{\}'/)?.[1] || 'property';
    return `Type error on untyped apiClient result (\`${prop}\` on \`{}\`) — always pass an explicit generic matching the server JSON. Gate: ${failedGate}`;
  }
  if (/Property 'alt' is missing/.test(text)) {
    return `Missing required \`alt\` on Avatar (or similar shared component) — satisfy prop types before build. Gate: ${failedGate}`;
  }
  if (/Type error:/i.test(text)) {
    const oneLine = text
      .split(/\r?\n/)
      .find((l) => /Type error:/i.test(l));
    return `${(oneLine || 'TypeScript build failure').slice(0, 220)} — fix locally with \`npm run build\` before merge. Gate: ${failedGate}`;
  }
  if (failedGate) {
    return `Quality gate \`${failedGate}\` failed — re-run and fix locally before merge/deploy.`;
  }
  return '';
}

/**
 * Resolve merge/deploy branch: env override, else Dev, else main, else none.
 * Set DISPATCH_MERGE_TARGET=none to disable merge.
 */
function resolveMergeTarget(cwd) {
  const raw = String(process.env.DISPATCH_MERGE_TARGET || '').trim();
  if (raw.toLowerCase() === 'none' || raw === '-') return '';
  if (raw) return raw;
  for (const candidate of ['Dev', 'dev', 'main', 'master']) {
    try {
      execSync(`git rev-parse --verify ${candidate}`, {
        cwd,
        stdio: 'ignore',
      });
      return candidate;
    } catch {
      /* try next */
    }
  }
  return '';
}

function git(cwd, command, { inherit = false } = {}) {
  return execSync(`git ${command}`, {
    cwd,
    encoding: 'utf8',
    stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * After Cursor returns: run local gates; on failure, re-invoke Cursor to fix; loop.
 */
async function enforceQualityGatesWithFixLoop({
  cursorLaunch,
  projectRoot,
  featureBranchHint,
  maxFixLoops,
  runLogPath,
}) {
  for (let attempt = 0; attempt <= maxFixLoops; attempt++) {
    const gates = runQualityGates(projectRoot, {
      onLog: (line) => {
        console.log(line);
        try {
          fs.appendFileSync(runLogPath, `${line}\n`, 'utf8');
        } catch {
          /* ignore */
        }
      },
    });

    if (gates.ok) return { ok: true, attempts: attempt };

    if (attempt === maxFixLoops) {
      return { ok: false, failedGate: gates.failedGate, attempts: attempt };
    }

    const failed = gates.results?.find((r) => !r.ok);
    const errorTail = (failed?.output || '').slice(-3500);
    console.log(
      `[dispatch] Quality gate failed (${gates.failedGate}). Fix loop ${attempt + 1}/${maxFixLoops}…`
    );

    // Persist a short lesson so the next terminal Cursor run remembers this class of bug.
    try {
      const lesson = summarizeGateFailureLesson(gates.failedGate, errorTail);
      if (lesson) {
        const added = appendAgentLesson(projectRoot, lesson);
        if (added) console.log(`[dispatch] Appended lesson to AGENTS.md: ${lesson}`);
      }
    } catch (err) {
      console.warn(`[dispatch] could not append AGENTS.md lesson: ${err.message}`);
    }

    const fixPrompt = [
      'LOCAL QUALITY GATES FAILED — fix and re-verify. Do not ask questions.',
      `Stay on the feature branch (prefer ${featureBranchHint} if it exists).`,
      `Failed gate: ${gates.failedGate}`,
      'Read the error output, fix the TypeScript/build/test failures, commit the fix,',
      'then re-run the same local verify commands until green.',
      'Especially for Next.js apps: `cd next_app && npm run build` must pass.',
      'Also append a one-line lesson to AGENTS.md if this is a new failure mode.',
      'Read AGENTS.md and .cursor/rules/ before fixing.',
      '',
      'Failure output:',
      errorTail || '(no output captured)',
    ].join('\n');

    try {
      await runCursorAgent(cursorLaunch, projectRoot, fixPrompt);
    } catch (err) {
      console.warn(`[dispatch] fix-loop agent error (will re-check gates): ${err.message}`);
      fs.appendFileSync(runLogPath, `fixLoopError=${err.message}\n`, 'utf8');
    }
  }
  return { ok: false, attempts: maxFixLoops };
}

/**
 * Merge current/feature branch into deploy target and push.
 */
function mergeFeatureIntoTarget(cwd, target, featureBranch) {
  const current = captureGit(cwd).branch;
  const source =
    featureBranch && featureBranch.startsWith('feature/')
      ? featureBranch
      : current.startsWith('feature/')
        ? current
        : current;

  console.log(`[dispatch] Merging ${source} → ${target}`);

  // Ensure feature branch is pushed first (best effort).
  try {
    git(cwd, `push -u origin ${source}`, { inherit: true });
  } catch {
    console.warn(`[dispatch] push ${source} failed (continuing merge attempt)`);
  }

  git(cwd, `fetch origin ${target}`, { inherit: true });
  try {
    git(cwd, `checkout ${target}`, { inherit: true });
  } catch {
    git(cwd, `checkout -b ${target} origin/${target}`, { inherit: true });
  }
  try {
    git(cwd, `pull --ff-only origin ${target}`, { inherit: true });
  } catch {
    /* may already be up to date / no remote tracking */
  }

  try {
    git(
      cwd,
      `merge --no-ff ${source} -m "merge: ${source} into ${target} (dispatch quality gates green)"`,
      { inherit: true }
    );
  } catch (err) {
    throw new Error(`git merge failed: ${err.message || err}`);
  }

  git(cwd, `push origin ${target}`, { inherit: true });

  // Return to feature branch for a predictable post-state.
  try {
    git(cwd, `checkout ${source}`, { inherit: true });
  } catch {
    /* ignore */
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
      env: {
        ...env,
        DISPATCH_NO_CLAUDE: '1',
        // Prefer headless / non-interactive behavior inside Coolify containers
        CI: env.CI || '1',
        NO_OPEN_BROWSER: env.NO_OPEN_BROWSER || '1',
      },
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
