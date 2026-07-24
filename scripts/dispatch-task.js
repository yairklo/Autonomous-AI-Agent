import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

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

const promptContent = `# Cursor Task Execution Instruction

## Task Description
${taskDescription}

## Strict Instructions for Cursor / Antigravity Agent
1. **Branching:** Create and switch to a new feature branch before editing code:
   \`git checkout -b feature/task-${Date.now()}\`
2. **Autonomy:** Run in non-interactive/auto-approve mode. Do NOT prompt for permission on file edits or terminal commands.
3. **Verification & Completion:**
   - Execute tests/validations to confirm correct behavior.
   - Stage all changes, commit them with a clean descriptive message, and push the branch to the remote origin.
`;

const promptPath = path.join(resolvedPath, 'PROMPT.md');
fs.writeFileSync(promptPath, promptContent, 'utf8');
console.log(`✓ Written prompt instructions to: ${promptPath}`);

const cursorrulesContent = `# Cursor Agent Rules
- You MUST read the instructions in PROMPT.md immediately.
- Create and switch to a new git branch before editing code: \`git checkout -b feature/task-${Date.now()}\` (or as specified in PROMPT.md).
- Run in non-interactive/auto-approve mode to execute the task fully. Do NOT prompt for permission on file edits or terminal commands.
- Run tests/validations, commit changes with a clean message, and push the branch to remote upon completion.
`;
const cursorrulesPath = path.join(resolvedPath, '.cursorrules');
fs.writeFileSync(cursorrulesPath, cursorrulesContent, 'utf8');
console.log(`✓ Written Cursor rules to: ${cursorrulesPath}`);

console.log(`Running headless agent in: ${resolvedPath}...`);
const claudeBin = 'claude';
const promptArg = `Read PROMPT.md and execute the task described there completely autonomously.
You MUST create a new feature branch, write the code, verify it, and git commit and push your changes.`;

const child = spawn(claudeBin, [
  '-p',
  promptArg,
  '--permission-mode', 'bypassPermissions',
  '--system-prompt', `You are an autonomous agent executing a task in ${resolvedPath}. Read PROMPT.md and .cursorrules first.`
], {
  cwd: resolvedPath,
  stdio: 'inherit',
  shell: true
});

await new Promise((resolve, reject) => {
  child.on('close', (code) => {
    if (code === 0) {
      console.log('✓ Headless agent execution completed successfully!');
      resolve();
    } else {
      reject(new Error(`Headless agent failed with exit code ${code}`));
    }
  });
  child.on('error', reject);
});
