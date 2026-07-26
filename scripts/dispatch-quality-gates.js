/**
 * Local verification gates for coding dispatches.
 * Detects project layout and runs the commands that catch Vercel/CI failures early.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * @param {string} projectRoot
 * @returns {{ id: string, cwd: string, command: string, args: string[] }[]}
 */
export function detectQualityGates(projectRoot) {
  const root = path.resolve(projectRoot);
  const gates = [];

  const nextApp = path.join(root, 'next_app');
  const serverDir = path.join(root, 'server');
  const mobileApp = path.join(root, 'mobile_app');

  if (fs.existsSync(path.join(nextApp, 'package.json'))) {
    // Prefer TypeScript check first — same class of errors Vercel fails on,
    // without requiring local Clerk/production secrets for full next build.
    gates.push({
      id: 'next_app:typecheck',
      cwd: nextApp,
      command: 'npx',
      args: ['tsc', '--noEmit', '-p', 'tsconfig.json'],
    });
    gates.push({
      id: 'next_app:build',
      cwd: nextApp,
      command: 'npm',
      args: ['run', 'build'],
    });
  } else if (fs.existsSync(path.join(root, 'package.json'))) {
    const pkg = readPkg(path.join(root, 'package.json'));
    if (pkg?.scripts?.build) {
      gates.push({
        id: 'root:build',
        cwd: root,
        command: 'npm',
        args: ['run', 'build'],
      });
    }
  }

  if (fs.existsSync(path.join(serverDir, 'package.json'))) {
    const pkg = readPkg(path.join(serverDir, 'package.json'));
    if (pkg?.scripts?.test) {
      gates.push({
        id: 'server:test',
        cwd: serverDir,
        command: 'npm',
        args: ['test', '--', '--passWithNoTests'],
      });
    }
  } else if (fs.existsSync(path.join(root, 'package.json'))) {
    const pkg = readPkg(path.join(root, 'package.json'));
    if (pkg?.scripts?.test) {
      gates.push({
        id: 'root:test',
        cwd: root,
        command: 'npm',
        args: ['test'],
      });
    }
  }

  if (fs.existsSync(path.join(mobileApp, 'package.json'))) {
    const pkg = readPkg(path.join(mobileApp, 'package.json'));
    if (pkg?.scripts?.typecheck) {
      gates.push({
        id: 'mobile_app:typecheck',
        cwd: mobileApp,
        command: 'npm',
        args: ['run', 'typecheck'],
      });
    } else if (pkg?.scripts?.lint) {
      gates.push({
        id: 'mobile_app:lint',
        cwd: mobileApp,
        command: 'npm',
        args: ['run', 'lint'],
      });
    }
  }

  return gates;
}

function readPkg(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Run all quality gates. Returns { ok, results[] }.
 * @param {string} projectRoot
 * @param {{ onLog?: (line: string) => void, timeoutMs?: number }} [opts]
 */
export function runQualityGates(projectRoot, opts = {}) {
  const onLog = opts.onLog || ((line) => console.log(line));
  const timeoutMs = Number(opts.timeoutMs || process.env.DISPATCH_GATE_TIMEOUT_MS || 600000);
  const gates = detectQualityGates(projectRoot);

  if (gates.length === 0) {
    onLog('[quality-gates] no gates detected — skipping');
    return { ok: true, results: [], skipped: true };
  }

  /** @type {{ id: string, ok: boolean, code: number|null, output: string }[]} */
  const results = [];

  for (const gate of gates) {
    onLog(`[quality-gates] RUN ${gate.id}: ${gate.command} ${gate.args.join(' ')} (cwd=${gate.cwd})`);
    const started = Date.now();
    const env = {
      ...process.env,
      CI: process.env.CI || '1',
      // Next/Vercel-like production build
      NODE_ENV: 'production',
    };
    // Local machines may lack Clerk keys that Vercel has; use a non-secret
    // placeholder so `next build` still reaches the TypeScript check / compile.
    if (gate.id === 'next_app:build' || gate.id === 'root:build') {
      if (!env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) {
        env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_test_quality_gate_placeholder';
      }
      if (!env.CLERK_SECRET_KEY) {
        env.CLERK_SECRET_KEY = 'sk_test_quality_gate_placeholder';
      }
    }
    const proc = spawnSync(gate.command, gate.args, {
      cwd: gate.cwd,
      encoding: 'utf8',
      shell: process.platform === 'win32',
      timeout: timeoutMs,
      env,
      maxBuffer: 20 * 1024 * 1024,
    });
    const output = `${proc.stdout || ''}\n${proc.stderr || ''}`.trim();
    const ok = proc.status === 0;
    const elapsed = Date.now() - started;
    onLog(
      `[quality-gates] ${ok ? 'PASS' : 'FAIL'} ${gate.id} exit=${proc.status} elapsedMs=${elapsed}`
    );
    if (!ok && output) {
      const tail = output.slice(-4000);
      onLog(`[quality-gates] --- failure output (tail) ---\n${tail}\n[quality-gates] --- end ---`);
    }
    results.push({
      id: gate.id,
      ok,
      code: proc.status,
      output,
      error: proc.error?.message || null,
    });
    if (!ok) {
      return { ok: false, results, failedGate: gate.id };
    }
  }

  onLog('[quality-gates] all gates passed');
  return { ok: true, results };
}

/**
 * Instructions embedded into every coding PROMPT.md / agent prompt.
 * @param {{ mergeTarget?: string, maxFixLoops?: number }} [opts]
 */
export function buildQualityGateInstructions(opts = {}) {
  const mergeTarget = opts.mergeTarget || process.env.DISPATCH_MERGE_TARGET || 'Dev';
  const maxFixLoops = Number(opts.maxFixLoops || process.env.DISPATCH_MAX_FIX_LOOPS || 5);

  return [
    '## Quality Gate Loop (MANDATORY — do not skip)',
    'After implementing code changes you MUST locally verify before declaring done.',
    'This catches TypeScript / Next.js / Vercel build failures before deploy.',
    '',
    '### Verify commands (run from the matching package directory)',
    '1. If `next_app/package.json` exists: `cd next_app && npm run build`',
    '2. If `server/package.json` has a test script: `cd server && npm test`',
    '3. If `mobile_app` has `typecheck` or `lint`: run that script',
    '4. Otherwise run root `npm test` / `npm run build` when those scripts exist',
    '',
    '### Fix loop',
    `- If ANY command fails: read the error, fix the code, re-run the failing command.`,
    `- Repeat until ALL gates pass (up to ~${maxFixLoops} fix iterations).`,
    '- Do NOT push a "done" state while `npm run build` (or equivalent) is red.',
    '- Do NOT rely on Vercel/CI to discover type errors — catch them locally.',
    '',
    '### Merge to deploy branch',
    `- After gates are green: commit, push the feature branch, then merge into \`${mergeTarget}\`.`,
    `- Example: \`git checkout ${mergeTarget} && git pull && git merge --no-ff <feature-branch> -m "merge: <feature>" && git push origin ${mergeTarget}\``,
    `- Then return to the feature branch. Merging \`${mergeTarget}\` triggers the production/Vercel build.`,
    '- If merge conflicts occur, resolve them, re-run quality gates, then finish the merge.',
    '',
    '### Done criteria',
    `- Local quality gates green`,
    `- Feature branch pushed`,
    `- Changes merged and pushed to \`${mergeTarget}\``,
  ].join('\n');
}
