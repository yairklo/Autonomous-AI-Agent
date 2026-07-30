import fs from 'node:fs';
import path from 'node:path';

const file = path.join(process.cwd(), 'scripts/dispatch-task.js');
let code = fs.readFileSync(file, 'utf8');

const injectionBlock = `
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
    fs.writeFileSync(l1Path, \`# L1 Architecture & Planner Protocol

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
\`\`\`\`, 'utf8');
  }

  if (!fs.existsSync(l2Path)) {
    console.log('[dispatch] Bootstrapping L2_execution.md in target project...');
    fs.writeFileSync(l2Path, \`# L2 Execution Protocol

You are the Executor (Claude 3.5 Haiku). Your goal is to execute a specific atomic sub-task safely and efficiently.

## Navigation & Awareness
- You are provided with a specific instruction and a targeted list of files to edit.
- Keep your changes strictly scoped to the target_files and the given instruction.
- Refer to AGENTS.md and .cursor/rules/ for persistent repository lessons and TypeScript rules.

## Execution Rules
- **Tactical Syntax**: Always ensure imports are correct and TypeScript typings are strictly adhered to. 
- **Quality Gates**: The system will automatically run quality gates (npm run build, npm test) after your edits. You must fix any reported errors.
- **Git Commits**: If you are requested to commit, use clean, descriptive commit messages.

Do not attempt to plan or architect new systems. Execute the given step and stop.\`, 'utf8');
  }

  if (!fs.existsSync(rootClaudePath)) {
    console.log('[dispatch] Bootstrapping CLAUDE.md in target project...');
    fs.writeFileSync(rootClaudePath, \`# Claude Routing Pointer

Welcome to the workspace. Follow these pointers for context:
1. **Architecture & Planning (L1)**: Read .claude/rules/L1_architecture.md.
2. **Execution & Implementation (L2)**: Read .claude/rules/L2_execution.md.
3. **Memory & Lessons**: Read AGENTS.md and .cursor/rules/.
4. **Current Task**: Check PROMPT.md and plan.json.

Use Graphify (.graph-context.xml) for high-level structure and ast-grep for targeted searches.\`, 'utf8');
  }
}
`;

// Insert the injection block before ensureGraphCache
code = code.replace(/let lastGraphKey = '';/, injectionBlock + '\nlet lastGraphKey = \'\';');

// Call it in the claude block
code = code.replace(
  /ensureGraphCache\(resolvedPath\);/,
  `ensureClaudeRules(resolvedPath, taskDescription);\n  ensureGraphCache(resolvedPath);`
);

fs.writeFileSync(file, code);
console.log('Successfully patched scripts/dispatch-task.js to inject rules dynamically.');
