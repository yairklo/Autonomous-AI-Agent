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
**Decision:** Server detects coding/dispatch intent and triggers the `dispatch_coding_task` MCP tool (which runs `dispatch-task.js`), rather than only relying on model tool-calls.  
**Why:** Reliable end-to-end; Grill-Me skip / "שגר ל-Cursor" becomes deterministic.  
**Date:** 2026-07-24

## D13 — Coding dispatch via MCP tool only
**Decision:** Coding work is exposed as local MCP tool `dispatch_coding_task` (`server/mcp-tools.js`), which runs `scripts/dispatch-task.js` → Cursor Agent CLI. Claude system prompt states ZERO file/shell capability; `/api/chat` orchestration invokes the MCP tool (not Bash).  
**Why:** Clear separation of duties; no raw shell/file edits from the voice layer; E2E asserts `tool_call` / `[mcp] tool=dispatch_coding_task`.  
**Date:** 2026-07-24
