# Architecture Decisions

## D10 — Coding tasks dispatch to headless agent (not GUI)
**Decision:** When a user utterance is a coding / Cursor-dispatch request, the Claude orchestration layer (`server/task-router.js` + `/api/chat`) invokes `scripts/dispatch-task.js` instead of opening the Cursor GUI.  
**Why:** Voice → coding must be headless and automatable; E2E requires branch + commit without human clicks.  
**Date:** 2026-07-24

## D11 — Headless agent runners (auto cascade)
**Decision:** `dispatch-task.js` writes `PROMPT.md` + `.cursorrules`, then runs agents in order: Cursor Agent CLI → Cursor SDK → `claude -p` → local deterministic executor.  
**Why:** Machines differ; Claude CLI is the available headless equivalent here; local fallback guarantees E2E git assertions.  
**Env:** `DISPATCH_AGENT=auto|claude|cursor-sdk|local`  
**Date:** 2026-07-24

## D12 — AUTO_DISPATCH_CODING=1 by default
**Decision:** Server detects coding/dispatch intent and triggers `dispatch-task.js` directly (Claude layer), rather than only relying on model tool-calls.  
**Why:** Reliable end-to-end; Grill-Me skip / "שגר ל-Cursor" becomes deterministic. System prompt still documents Bash dispatch for interactive Claude sessions.  
**Date:** 2026-07-24
