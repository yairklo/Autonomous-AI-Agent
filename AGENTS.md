# Agent memory

Persistent instructions for Cursor Agent (including headless terminal runs).

## Always
- Read `PROMPT.md`, `.cursorrules`, `AGENTS.md`, `.claude/rules/` (L1/L2/L3 protocol), and `.cursor/rules/`.
- Run local production build/tests after code changes; fix until green.
- Append new deploy/type lessons here when you discover them.

## Durable lessons have moved
The lessons that used to accumulate here have been promoted into glob-scoped rule files under
`.cursor/rules/`:
- `00-core-invariants.mdc` — secrets hygiene, Docker image discipline, quality-gate discipline. **Always applies.**
- `whatsapp-playwright.mdc` — Playwright/Chromium version pin, WhatsApp session + JID handling, tracked-groups persistence.
- `server-runtime.mdc` — `server/index.js` duplicate-ESM-import startup failure.
- `integrations.mdc` — Gemini orchestration, voice GUI secure-context requirement, CV/Drive sync.

(A stray `typescript-vercel-quality.mdc` — copy-pasted from JoinUpApp and referencing `next_app`/`Avatar`,
neither of which exist in this repo — was removed; its one real line, the voice GUI secure-context
lesson, is now in `integrations.mdc`.)

## When you learn a new deploy bug
1. Append a short bullet under **New lessons (not yet promoted)** below.
2. Promote it into the matching `.mdc` file above (or a new one, with an explicit `globs:`) once this
   section has ~5 unpromoted bullets, or before a release.

## New lessons (not yet promoted)
- Job matching is CS-graduate / junior software (Frontend, Backend, QA, data, mobile, DevOps, intern) not Full Stack only. Exclude non-CS disciplines (materials / mechanical / civil / chemical / electrical). Product Manager stays out.
