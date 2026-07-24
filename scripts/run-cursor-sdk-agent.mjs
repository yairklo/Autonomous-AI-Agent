/**
 * Optional Cursor SDK headless runner.
 * Requires: npm i @cursor/sdk and CURSOR_API_KEY.
 *
 * Usage: node scripts/run-cursor-sdk-agent.mjs --cwd <path> --task <text>
 */
const args = process.argv.slice(2);
let cwd = process.cwd();
let task = '';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--cwd' && args[i + 1]) {
    cwd = args[++i];
  } else if (args[i] === '--task' && args[i + 1]) {
    task = args[++i];
  }
}

if (!task) {
  console.error('Missing --task');
  process.exit(1);
}
if (!process.env.CURSOR_API_KEY) {
  console.error('CURSOR_API_KEY is required for Cursor SDK agent');
  process.exit(1);
}

let Agent;
try {
  ({ Agent } = await import('@cursor/sdk'));
} catch (err) {
  console.error('Install @cursor/sdk to use cursor-sdk agent mode:', err.message);
  process.exit(1);
}

const prompt = `Read PROMPT.md and .cursorrules. Execute the task fully, autonomously, non-interactively.
Create the feature branch named in PROMPT.md, implement the changes, run tests, commit, and push.
Task: ${task}`;

const result = await Agent.prompt(prompt, {
  apiKey: process.env.CURSOR_API_KEY,
  model: { id: process.env.CURSOR_MODEL || 'composer-2.5' },
  local: { cwd },
});

console.log('Cursor SDK status:', result.status);
if (result.result) console.log(result.result);
if (result.status === 'error') process.exit(2);
