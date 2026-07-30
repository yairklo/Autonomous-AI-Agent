const { execSync } = require('child_process');

const prompt = process.argv[2];
if (!prompt) {
  console.error('No prompt provided');
  process.exit(1);
}

try {
  const output = execSync(
    `npx -y @anthropic-ai/claude-code -p "${prompt.replace(/"/g, '\\"')}" --print --auto-approve`,
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  );
  console.log(output);
} catch (e) {
  console.error(e.stderr || e.message);
  process.exit(1);
}
