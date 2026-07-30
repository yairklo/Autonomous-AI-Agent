import fs from 'node:fs';
import path from 'node:path';

const file = path.join(process.cwd(), 'scripts/dispatch-task.js');
let code = fs.readFileSync(file, 'utf8');

// 1. Remove Claude code execution block
code = code.replace(
  /if \(requestedMode === 'claude' \|\| requestedMode === 'local' \|\| requestedMode === 'local-fallback'\) \{\s*console\.warn\(\s*`\[dispatch\] DISPATCH_AGENT=\$\{requestedMode\} is not allowed for code execution \(Claude\/local cannot edit code\)\. Using Cursor Agent CLI\.`\s*\);\s*\}/s,
  `if (requestedMode === 'local' || requestedMode === 'local-fallback') {
  console.warn(
    \`[dispatch] DISPATCH_AGENT=\${requestedMode} is not allowed for code execution. Using Cursor Agent CLI.\`
  );
}`
);

// 2. Add resolveClaudeLaunch function
const resolveClaudeLaunchStr = `
function resolveClaudeLaunch(model) {
  return {
    bin: 'npx',
    display: 'claude code',
    kind: 'cmd',
    buildArgs: (prompt, cwd) => [
      '-y',
      '@anthropic-ai/claude-code',
      '-p',
      prompt,
      '--auto-approve',
      '--print'
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

let lastGraphKey = '';
function ensureGraphCache(cwd) {
  const currentKey = getGraphCacheKey(cwd);
  if (currentKey !== lastGraphKey) {
    console.log('[dispatch] Building fresh Graphify/AST-grep index...');
    try {
      execSync('npm run build:graph', { cwd, stdio: 'inherit' });
    } catch (e) {
      console.warn('[dispatch] Warning: build:graph failed or missing.');
    }
    lastGraphKey = currentKey;
  }
}
`;
code = code.replace(/function resolveCursorLaunch\(\) \{/, resolveClaudeLaunchStr + '\nfunction resolveCursorLaunch() {');


// 3. Replace the main execution logic
const mainExecTarget = `const cursorLaunch = resolveCursorLaunch();
console.log(\`Running headless Cursor agent in: \${resolvedPath}\`);
console.log(\`✓ Cursor executor resolved: \${cursorLaunch.display}\`);`;

const mainExecReplacement = `
let cursorLaunch = resolveCursorLaunch();
if (requestedMode === 'claude') {
  ensureGraphCache(resolvedPath);
  console.log(\`Running Claude Planner (claude-3-5-sonnet)...\`);
  
  const plannerLaunch = resolveClaudeLaunch('claude-3-5-sonnet-20241022');
  const plannerPrompt = \`Read .claude/rules/L1_architecture.md. Output ONLY a valid JSON array of tasks to plan.json based on this task: \${taskDescription}\`;
  
  try {
    await runCursorAgent(plannerLaunch, resolvedPath, plannerPrompt);
  } catch (err) {
    console.error(\`✗ Claude Planner failed: \${err.message}\`);
    process.exit(1);
  }

  let plan;
  try {
    plan = JSON.parse(fs.readFileSync(path.join(resolvedPath, 'plan.json'), 'utf8'));
    console.log(\`[dispatch] Claude Planner generated \${plan.length} sub-tasks.\`);
  } catch (err) {
    console.error(\`✗ Failed to parse plan.json from Claude Planner\`);
    process.exit(1);
  }

  // Iterate over tasks with Haiku
  let haikuLaunch = resolveClaudeLaunch('claude-3-5-haiku-20241022');
  
  for (const step of plan) {
    console.log(\`[dispatch] Executing step \${step.id}...\`);
    const stepPrompt = \`Read .claude/rules/L2_execution.md. Execute instruction: "\${step.instruction}" on files: \${step.target_files.join(', ')}\`;
    
    let stepSuccess = false;
    for (let retry = 0; retry < 3; retry++) {
      try {
        await runCursorAgent(haikuLaunch, resolvedPath, stepPrompt);
      } catch (err) {
        console.warn(\`✗ Step \${step.id} execution error: \${err.message}\`);
      }
      
      const gateResult = runQualityGates(resolvedPath, { onLog: console.log });
      if (gateResult.ok) {
        stepSuccess = true;
        break;
      }
      console.warn(\`[dispatch] Quality gates failed for step \${step.id}, retry \${retry+1}/3\`);
    }

    if (!stepSuccess) {
      console.error(\`[dispatch] Nuclear Escalation for step \${step.id}! Rolling back and escalating to Sonnet.\`);
      execSync('git reset --hard', { cwd: resolvedPath, stdio: 'ignore' });
      const escalateLaunch = resolveClaudeLaunch('claude-3-5-sonnet-20241022');
      const escalatePrompt = \`Read .claude/rules/L2_execution.md. Execute instruction: "\${step.instruction}" on files: \${step.target_files.join(', ')}\`;
      await runCursorAgent(escalateLaunch, resolvedPath, escalatePrompt);
      
      const escalateGates = runQualityGates(resolvedPath, { onLog: console.log });
      if (!escalateGates.ok) {
        console.error(\`✗ Escalation failed. Halting pipeline.\`);
        process.exit(1);
      }
    }
  }

  console.log('✓ Claude execution completed. Falling through to final pushes.');
  // Override cursorLaunch so downstream logging doesn't crash
  cursorLaunch = resolveClaudeLaunch('claude-3-5-haiku'); 
} else {
  console.log(\`Running headless Cursor agent in: \${resolvedPath}\`);
  console.log(\`✓ Cursor executor resolved: \${cursorLaunch.display}\`);
`;

// Make sure the else block is closed, so we wrap the cursor execution in an else if not claude
code = code.replace(mainExecTarget, mainExecReplacement + '\n' + mainExecTarget + '\n}\n');

// 4. Update Auth Failure Detection
const authInterceptTarget = `if (!looksLikeAuthFailure(chunkText) && !extractAuthUrl(chunkText)) return;`;
const authInterceptReplacement = `
if (!looksLikeAuthFailure(chunkText) && !extractAuthUrl(chunkText) && !chunkText.includes('Sign in to Anthropic')) return;
`;
code = code.replace(authInterceptTarget, authInterceptReplacement);


fs.writeFileSync(file, code);
console.log('Successfully patched scripts/dispatch-task.js');
