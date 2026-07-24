# Cursor Task Execution Instruction

## Task Description
Implement a focused MCP tool for code task dispatch, excluding all external integrations (Google Drive/Calendar are out of scope for now).

Goal:
Convert our existing `scripts/dispatch-task.js` pipeline into an explicit MCP tool (`dispatch_coding_task`) and restrict Claude from attempting raw shell commands or direct file editing.

Project path: C:/Autonomous AI Agent

Requirements:

1. MCP Tool Registration:
   - Create a local MCP tool definition (e.g. in `server/mcp-tools.js` or integrate into existing router):
     - Tool Name: `dispatch_coding_task`
     - Description: "Dispatches a software development/coding task to Cursor Agent CLI in headless mode."
     - Parameters: `projectPath` (string), `taskDescription` (string).
     - Execution Logic: Invokes `node scripts/dispatch-task.js --project <projectPath> --task <taskDescription>`.

2. System Prompt Enforcement:
   - Update the system instructions for Claude in `server/task-router.js` / `/api/chat`:
     - Explicitly state that Claude has ZERO capability to directly edit files or run raw terminal commands.
     - Mandate that any request involving code creation, bug fixes, or project modifications MUST be executed solely by calling the `dispatch_coding_task` MCP tool.

3. Verification:
   - Update/run `node scripts/test-task-dispatch-e2e.js` to ensure that sending a chat request causes Claude to trigger the `dispatch_coding_task` MCP tool, which then successfully runs `dispatch-task.js` and invokes Cursor CLI.

Implement this clean MCP layer and confirm the test passes cleanly.

Skip Grill-Me Mode and dispatch this coding task directly to Cursor.

## Strict Instructions for Cursor / Antigravity Agent
1. **Branching:** Create and switch to a new feature branch before editing code:
   `git checkout -b feature/task-1784907600724`
2. **Autonomy:** Run in non-interactive/auto-approve mode. Do NOT prompt for permission on file edits or terminal commands.
3. **Verification & Completion:**
   - Execute tests/validations to confirm correct behavior.
   - Stage all changes, commit them with a clean descriptive message, and push the branch to the remote origin.
4. **Do not delete PROMPT.md or .cursorrules** until after commit (E2E verifies them).
