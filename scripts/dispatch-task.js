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
import {
  applyWorkspaceDispatchPolicy,
  findWorkspaceByRoot,
} from '../server/workspaces.js';
import { buildCursorAgentEnv as buildAgentEnv } from '../server/cli-auth/cursor-env.js';
import {
  extractAuthUrl,
  looksLikeAuthFailure,
} from '../server/cli-auth/parse-auth-url.js';

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

if (!fs.existsSync(resolvedPath)) {
  fs.mkdirSync(resolvedPath, { recursive: true });
}

if (!isGitWorkTree(resolvedPath)) {
  console.error(
    `✗ Not a git repository: ${resolvedPath}\n` +
      '  Coding dispatch requires a git clone (see workspaces.json).\n' +
      '  Set AGENT_PROJECT_ROOT / JOINUP_PROJECT_ROOT / PORTFOLIO_PROJECT_ROOT / ECODRIVE_PROJECT_ROOT\n' +
      '  to a clone under /workspaces, or run: npm run bootstrap:workspace'
  );
  process.exit(1);
}

applyRegistryPolicyForPath(resolvedPath);

const branchName = `feature/task-${Date.now()}`;
const requestedMode = (process.env.DISPATCH_AGENT || 'cursor').toLowerCase();
const agentTimeoutMs = Number(process.env.DISPATCH_AGENT_TIMEOUT_MS || 900000);
const maxFixLoops = Number(process.env.DISPATCH_MAX_FIX_LOOPS || 5);
const mergeTarget = resolveMergeTarget(resolvedPath);

if (requestedMode === 'local' || requestedMode === 'local-fallback') {
  console.warn(
    `[dispatch] DISPATCH_AGENT=${requestedMode} is not allowed for code execution. Using Cursor Agent CLI.`
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
  console.log('✓ Headless agent finished (engine=claude).');
  fs.appendFileSync(
    runLogPath,
    `finishedAt=${new Date().toISOString()}\nengine=claude\nbranch=${afterDry.branch}\ncommit=${afterDry.commit}\n`,
    'utf8'
  );
  console.log('✓ Headless Cursor agent execution completed successfully!');
  process.exit(0);
}


  ensureGraphCache(resolvedPath);
  console.log(`Running Claude Planner (claude-3-5-sonnet)...`);
  
  const plannerLaunch = resolveClaudeLaunch('claude-3-5-sonnet-20241022');
  const planFileName = `plan-${Date.now()}.json`;
  const plannerPrompt = `Read PROMPT.md, .cursorrules, AGENTS.md, and .cursor/rules/. Create a file named ${planFileName} containing ONLY a valid JSON array of tasks to implement this feature: ${taskDescription}. You MUST write to ${planFileName} using your file tools. Do not ask for confirmation.`;
  
  try {
    await runAgentProcess(plannerLaunch, resolvedPath, plannerPrompt);
  } catch (err) {
    console.error(`✗ Claude Planner failed: ${err.message}`);
    process.exit(1);
  }

  let plan;
  try {
    plan = JSON.parse(fs.readFileSync(path.join(resolvedPath, planFileName), 'utf8'));
    console.log(`[dispatch] Claude Planner generated ${plan.length} sub-tasks.`);
  } catch (err) {
    console.error(`✗ Failed to parse ${planFileName} from Claude Planner`);
    process.exit(1);
  }

  let haikuLaunch = resolveClaudeLaunch('claude-3-5-haiku-20241022');
  
  for (const step of plan) {
    console.log(`[dispatch] Executing step ${step.id || 'unknown'}...`);
    const filesStr = (step.target_files || []).join(', ');
    const instructionStr = step.instruction || step.task || step.description || 'Implement step according to plan';
    const stepPrompt = `Read AGENTS.md and .cursorrules. Execute instruction: "${instructionStr}" on files: ${filesStr}. Complete the task and do not ask for confirmation.`;
    
    let stepSuccess = false;
    for (let retry = 0; retry < 3; retry++) {
      try {
        await runAgentProcess(haikuLaunch, resolvedPath, stepPrompt);
      } catch (err) {
        console.warn(`✗ Step ${step.id} execution error: ${err.message}`);
      }
      
      const gateResult = runQualityGates(resolvedPath, { onLog: console.log });
      if (gateResult.ok) {
        stepSuccess = true;
        break;
      }
      console.warn(`[dispatch] Quality gates failed for step ${step.id}, retry ${retry+1}/3`);
    }

    if (!stepSuccess) {
      console.error(`[dispatch] Nuclear Escalation for step ${step.id}! Rolling back and escalating to Sonnet.`);
      execSync('git reset --hard', { cwd: resolvedPath, stdio: 'ignore' });
      const escalateLaunch = resolveClaudeLaunch('claude-3-5-sonnet-20241022');
      const escalateFilesStr = (step.target_files || []).join(', ');
      const escalateInstruction = step.instruction || step.task || step.description || 'Implement step according to plan';
      const escalatePrompt = `Read AGENTS.md and .cursorrules. Execute instruction: "${escalateInstruction}" on files: ${escalateFilesStr}. Complete the task and do not ask for confirmation.`;
      await runAgentProcess(escalateLaunch, resolvedPath, escalatePrompt);
      
      const escalateGates = runQualityGates(resolvedPath, { onLog: console.log });
      if (!escalateGates.ok) {
        console.error(`✗ Escalation failed. Halting pipeline.`);
        process.exit(1);
      }
    }
  }

  console.log('✓ Claude execution completed. Falling through to final pushes.');
  const agentLaunch = resolveClaudeLaunch('claude-3-5-haiku'); 
// Re-assert prompt files exist for E2E (Cursor sometimes removes them).
if (!fs.existsSync(promptPath)) fs.writeFileSync(promptPath, promptContent, 'utf8');
if (!fs.existsSync(cursorrulesPath)) fs.writeFileSync(cursorrulesPath, cursorrulesContent, 'utf8');

let after = captureGit(resolvedPath);
console.log(`✓ Post-agent git: branch=${after.branch} commit=${after.commit}`);
console.log('✓ Headless agent finished (engine=claude) — entering quality-gate loop.');

if (process.env.DISPATCH_SKIP_QUALITY_GATES !== '1') {
  const gateResult = await enforceQualityGatesWithFixLoop({
    agentLaunch,
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

// Always push the feature branch after green gates. With mergeTarget=none the
// previous code relied on Cursor to push — if the agent died mid-run we marked
// success on a local branch rename with no remote update.
if (process.env.DISPATCH_SKIP_PUSH !== '1') {
  try {
    pushFeatureBranch(resolvedPath, after.branch || branchName);
    fs.appendFileSync(
      runLogPath,
      `pushedBranch=${after.branch || branchName}\n`,
      'utf8'
    );
    console.log(`✓ Pushed feature branch ${after.branch || branchName} to origin`);
  } catch (err) {
    console.error(`✗ git push failed: ${err.message}`);
    fs.appendFileSync(runLogPath, `pushError=${err.message}\n`, 'utf8');
    process.exit(1);
  }
}

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
  `finishedAt=${new Date().toISOString()}\nengine=claude\nbranch=${after.branch}\ncommit=${after.commit}\n`,
  'utf8'
);

// Success requires a NEW commit SHA — renaming/checking out a feature branch
// on the same commit must not count as done.
if (!after.commit || after.commit === before.commit) {
  const dirty = isDirtyWorkTree(resolvedPath);
  console.error(
    '✗ Agent produced no new commit ' +
      `(before=${before.commit || '(none)'} after=${after.commit || '(none)'} branch=${after.branch || '(none)'}).`
  );
  if (dirty) {
    console.error(
      '  Working tree still has uncommitted changes. Salvage in the container:\n' +
        `    cd ${resolvedPath}\n` +
        '    git status\n' +
        '    git diff\n' +
        '    git add -A && git commit -m "…" && git push -u origin HEAD\n' +
        '  Or re-dispatch a short task: commit+push existing mic/GUI changes only (do not redo).'
    );
  }
  process.exit(1);
}

console.log('✓ Headless Cursor agent execution completed successfully!');

function isGitWorkTree(cwd) {
  try {
    execSync('git rev-parse --is-inside-work-tree', {
      cwd,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function applyRegistryPolicyForPath(cwd) {
  const ws = findWorkspaceByRoot(cwd);
  if (!ws?.dispatch) return;
  const next = applyWorkspaceDispatchPolicy(ws, {
    env: process.env,
    forcePolicy: true,
  });
  if (next.DISPATCH_MERGE_TARGET != null) {
    process.env.DISPATCH_MERGE_TARGET = next.DISPATCH_MERGE_TARGET;
  }
  if (next.DISPATCH_MAX_FIX_LOOPS != null) {
    process.env.DISPATCH_MAX_FIX_LOOPS = next.DISPATCH_MAX_FIX_LOOPS;
  }
  if (next.DISPATCH_AGENT_TIMEOUT_MS != null) {
    process.env.DISPATCH_AGENT_TIMEOUT_MS = next.DISPATCH_AGENT_TIMEOUT_MS;
  }
  console.log(
    `✓ Workspace policy: id=${ws.id} mergeTarget=${process.env.DISPATCH_MERGE_TARGET || '(unset)'} maxFixLoops=${process.env.DISPATCH_MAX_FIX_LOOPS || '(unset)'}`
  );
}


function resolveClaudeLaunch(model) {
  return {
    bin: process.platform === 'win32' ? 'npx.cmd' : 'npx',
    display: 'claude code',
    kind: 'cmd',
    buildArgs: (prompt, cwd) => [
      '-y',
      '@anthropic-ai/claude-code',
      '--print',
      '--permission-mode',
      'bypassPermissions',
      prompt
    ] // model passing might require specific flags or env vars for claude CLI
  };
}

function getGraphCacheKey(cwd) {
  try {
    const commit = execSync('git rev-parse HEAD', { cwd, encoding: 'utf8' }).trim();
    const status = execSync('git status --porcelain', { cwd, encoding: 'utf8' }).trim();
    return commit + status;
  } catch {
    return Date.now().toString();
  }
}


function ensureClaudeRules(cwd, taskDesc) {
  const claudeDir = path.join(cwd, '.claude/rules');
  if (!fs.existsSync(claudeDir)) {
    fs.mkdirSync(claudeDir, { recursive: true });
  }

  const l1Path = path.join(claudeDir, 'L1_architecture.md');
  const l2Path = path.join(claudeDir, 'L2_execution.md');
  const rootClaudePath = path.join(cwd, 'CLAUDE.md');

  if (!fs.existsSync(l1Path)) {
    console.log('[dispatch] Bootstrapping L1_architecture.md in target project...');
    fs.writeFileSync(l1Path, `# L1 Architecture & Planner Protocol

You are the Planner (Claude 3.5 Sonnet). Your goal is to analyze the user's task, navigate the codebase using the provided graph context (.graph-context.xml), and produce a structured JSON plan of atomic sub-tasks.

## Rules
1. **3-File Rule:** Never edit more than 3 files in a single atomic sub-task.
2. **Layer Isolation Rule:** Never mix Database schema changes and UI/Frontend edits in the same sub-task. Separate them into distinct atomic steps.

## Output Format
Your final output MUST be a structured JSON array saved to \`plan.json\` in the workspace root. Do NOT execute the tasks yourself.

Format:
\`\`\`json
[
  {
    "id": "STEP_1",
    "target_files": ["src/db/schema.ts"],
    "instruction": "Add the new column status to the Users table."
  }
]
\`\`\``, 'utf8');
  }

  if (!fs.existsSync(l2Path)) {
    console.log('[dispatch] Bootstrapping L2_execution.md in target project...');
    fs.writeFileSync(l2Path, `# L2 Execution Protocol

You are the Executor (Claude 3.5 Haiku). Your goal is to execute a specific atomic sub-task safely and efficiently.

## Navigation & Awareness
- You are provided with a specific instruction and a targeted list of files to edit.
- Keep your changes strictly scoped to the target_files and the given instruction.
- Refer to AGENTS.md and .cursor/rules/ for persistent repository lessons and TypeScript rules.

## Execution Rules
- **Tactical Syntax**: Always ensure imports are correct and TypeScript typings are strictly adhered to. 
- **Quality Gates**: The system will automatically run quality gates (npm run build, npm test) after your edits. You must fix any reported errors.
- **Git Commits**: If you are requested to commit, use clean, descriptive commit messages.

Do not attempt to plan or architect new systems. Execute the given step and stop.`, 'utf8');
  }

  if (!fs.existsSync(rootClaudePath)) {
    console.log('[dispatch] Bootstrapping CLAUDE.md in target project...');
    fs.writeFileSync(rootClaudePath, `# Claude Routing Pointer

Welcome to the workspace. Follow these pointers for context:
1. **Architecture & Planning (L1)**: Read .claude/rules/L1_architecture.md.
2. **Execution & Implementation (L2)**: Read .claude/rules/L2_execution.md.
3. **Memory & Lessons**: Read AGENTS.md and .cursor/rules/.
4. **Current Task**: Check PROMPT.md and plan.json.

Use Graphify (.graph-context.xml) for high-level structure and ast-grep for targeted searches.`, 'utf8');
  }
}

var lastGraphKey = '';
function ensureGraphCache(cwd) {
  const currentKey = getGraphCacheKey(cwd);
  if (currentKey !== lastGraphKey) {
    console.log('[dispatch] Building fresh Graphify/AST-grep index...');
    try {
      execSync('npm run build:graph', { cwd, stdio: 'ignore' });
    } catch (e) {
      console.warn('[dispatch] Warning: build:graph failed or missing.');
    }
    lastGraphKey = currentKey;
  }
}


async function runAgentProcess(launch, cwd, prompt) {
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
  agentLaunch,
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
      await runAgentProcess(agentLaunch, projectRoot, fixPrompt);
    } catch (err) {
      console.warn(`[dispatch] fix-loop agent error (will re-check gates): ${err.message}`);
      fs.appendFileSync(runLogPath, `fixLoopError=${err.message}\n`, 'utf8');
    }
  }
  return { ok: false, attempts: maxFixLoops };
}

/**
 * Push current/feature branch to origin (required when mergeTarget is none).
 */
function pushFeatureBranch(cwd, featureBranch) {
  const current = captureGit(cwd).branch;
  const source =
    (featureBranch && String(featureBranch).trim()) ||
    current ||
    '';
  if (!source) {
    throw new Error('No branch to push');
  }
  // Stay on the branch we intend to publish.
  if (current !== source) {
    try {
      git(cwd, `checkout ${source}`, { inherit: true });
    } catch {
      git(cwd, `checkout -b ${source}`, { inherit: true });
    }
  }
  console.log(`[dispatch] Pushing ${source} → origin`);
  git(cwd, `push -u origin ${source}`, { inherit: true });
}

function isDirtyWorkTree(cwd) {
  try {
    const out = execSync('git status --porcelain', {
      cwd,
      encoding: 'utf8',
    }).trim();
    return Boolean(out);
  } catch {
    return false;
  }
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
    const childEnv = buildAgentEnv(env);
    console.log(
      `[spawn] HOME=${childEnv.HOME || '(unset)'} ` +
        `agentDir=${path.join(childEnv.HOME || '', '.claude')}`
    );
    const child = spawn(command, spawnArgs, {
      cwd,
      env: childEnv,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsVerbatimArguments: launch.kind === 'cmd' || /\.cmd$/i.test(launch.bin),
    });
    let stdout = '';
    let stderr = '';
    let authAborted = false;
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      reject(new Error(`Timed out after ${timeoutMs}ms: ${launch.display}`));
    }, timeoutMs);

    const maybeAbortAuth = (chunkText) => {
      if (authAborted) return;
      
if (!looksLikeAuthFailure(chunkText) && !extractAuthUrl(chunkText) && !chunkText.includes('Sign in to Anthropic')) return;

      // Only abort when auth language is present (URL alone can appear in normal docs).
      if (!looksLikeAuthFailure(`${stdout}\n${stderr}\n${chunkText}`)) return;
      authAborted = true;
      clearTimeout(timer);
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      const authUrl = extractAuthUrl(`${stdout}\n${stderr}\n${chunkText}`);
      const err = new Error(
        `Authentication required during Cursor run` +
          (authUrl ? ` — open ${authUrl}` : '')
      );
      err.code = 'CLI_AUTH_REQUIRED';
      err.authUrl = authUrl || '';
      reject(err);
    };

    child.stdout.on('data', (c) => {
      const t = c.toString();
      stdout += t;
      process.stdout.write(t);
      maybeAbortAuth(t);
    });
    child.stderr.on('data', (c) => {
      const t = c.toString();
      stderr += t;
      process.stderr.write(t);
      maybeAbortAuth(t);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (authAborted) return;
      if (code === 0) resolve({ stdout, stderr, code });
      else {
        const combined = `${stderr || ''}\n${stdout || ''}`;
        if (looksLikeAuthFailure(combined)) {
          const authUrl = extractAuthUrl(combined);
          const err = new Error(
            `${launch.display} exited ${code}: Authentication required` +
              (authUrl ? ` — open ${authUrl}` : '')
          );
          err.code = 'CLI_AUTH_REQUIRED';
          err.authUrl = authUrl || '';
          reject(err);
          return;
        }
        reject(
          new Error(`${launch.display} exited ${code}: ${(stderr || stdout).slice(-800)}`)
        );
      }
    });
  });
}

// buildAgentEnv lives in server/cli-auth/cursor-env.js (shared with health gate).

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
