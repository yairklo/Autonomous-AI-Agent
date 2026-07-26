/**
 * Seed / refresh durable Cursor agent memory inside a target project
 * (AGENTS.md + .cursor/rules) without wiping project-specific lessons.
 */
import fs from 'node:fs';
import path from 'node:path';

const TYPESCRIPT_RULE = `---
description: Prevent Vercel/Next TypeScript build failures
globs: "**/*.{ts,tsx}"
alwaysApply: true
---

# TypeScript / deploy quality

- Always give \`apiClient\` / fetch helpers an explicit generic return type. Never read properties from untyped \`{}\`.
- Check shared component prop types (e.g. required \`alt\` on Avatar) before using them.
- After TS/UI changes run the production build locally (\`next_app\`: \`npm run build\`) and fix errors in a loop before finishing.
- Prefer catching Vercel failures locally; do not merge a red build.
`;

const AGENTS_STUB = `# Agent memory

Persistent instructions for Cursor Agent (including headless terminal runs).

## Always
- Read \`PROMPT.md\`, \`.cursorrules\`, \`AGENTS.md\`, and \`.cursor/rules/\`.
- Run local production build/tests after code changes; fix until green.
- Append new deploy/type lessons here when you discover them.
`;

/**
 * Ensure durable memory files exist. Never overwrites non-empty AGENTS.md body lessons
 * except to ensure a header exists. Always ensures the typescript quality rule file exists
 * (creates if missing; does not overwrite if already present).
 *
 * @param {string} projectRoot
 * @param {{ onLog?: (line: string) => void }} [opts]
 */
export function ensureProjectAgentMemory(projectRoot, opts = {}) {
  const onLog = opts.onLog || (() => {});
  const root = path.resolve(projectRoot);
  const rulesDir = path.join(root, '.cursor', 'rules');
  fs.mkdirSync(rulesDir, { recursive: true });

  const tsRulePath = path.join(rulesDir, 'typescript-vercel-quality.mdc');
  if (!fs.existsSync(tsRulePath)) {
    fs.writeFileSync(tsRulePath, TYPESCRIPT_RULE, 'utf8');
    onLog(`[agent-memory] created ${tsRulePath}`);
  }

  const agentsPath = path.join(root, 'AGENTS.md');
  if (!fs.existsSync(agentsPath)) {
    fs.writeFileSync(agentsPath, AGENTS_STUB, 'utf8');
    onLog(`[agent-memory] created ${agentsPath}`);
  }

  return { rulesDir, tsRulePath, agentsPath };
}

/**
 * Append a lesson bullet to AGENTS.md (deduped by substring match).
 * @param {string} projectRoot
 * @param {string} lesson
 */
export function appendAgentLesson(projectRoot, lesson) {
  const agentsPath = path.join(path.resolve(projectRoot), 'AGENTS.md');
  ensureProjectAgentMemory(projectRoot);
  const text = fs.readFileSync(agentsPath, 'utf8');
  const line = `- ${lesson.trim()}`;
  if (text.includes(lesson.trim())) return false;
  const section = '\n## Lessons learned (auto)\n';
  if (text.includes('## Lessons learned (auto)')) {
    fs.writeFileSync(agentsPath, `${text.trimEnd()}\n${line}\n`, 'utf8');
  } else {
    fs.writeFileSync(agentsPath, `${text.trimEnd()}\n${section}${line}\n`, 'utf8');
  }
  return true;
}
