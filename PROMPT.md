# Cursor Task Execution Instruction

## Task Description
Bug: Voice recording button in the Autonomous Agent GUI does nothing when clicked — no audio is recorded and no transcription appears. This worked correctly when running the app locally on a developer machine, but broke after deploying to the VPS. No error message is shown, and the browser does not even prompt for microphone permission when the button is clicked.

Leading hypothesis: the recording feature uses the browser `navigator.mediaDevices.getUserMedia` API, which browsers only allow in a "secure context" — i.e. `https://` or `http://localhost`. If the VPS serves the GUI over plain HTTP (not HTTPS), `getUserMedia` will be `undefined` or silently blocked, so clicking the button triggers no permission prompt and no visible error (likely because the failure isn't caught/logged in the UI). This matches the reported symptoms exactly (works on localhost, breaks on VPS, no permission prompt, no error shown).

Tasks:
1. Locate the voice recording component/button in the GUI codebase and confirm it uses `navigator.mediaDevices.getUserMedia` (or similar Web Audio/MediaRecorder API) to start recording.
2. Confirm whether the failure is due to insecure context (HTTP instead of HTTPS) on the VPS — check how the GUI is served in production/VPS deployment (reverse proxy config, Docker/nginx setup, ports, whether TLS is configured).
3. Add proper error handling/logging around the `getUserMedia` call and any recording/transcription pipeline so failures are surfaced clearly in the UI/console instead of failing silently, to make this class of bug diagnosable in the future.
4. If the root cause is confirmed to be missing HTTPS on the VPS: implement a fix so the GUI is served over HTTPS (e.g. configure TLS termination via reverse proxy/nginx with a certificate, or document/apply the necessary deployment change), so the secure-context requirement is satisfied.
5. If the root cause is something else (e.g. a regression in the recording/transcription code path itself, wrong API usage, a broken event handler, or an environment variable/config difference between local and VPS), find and fix that instead.
6. After the fix, verify end-to-end: clicking the record button triggers a microphone permission prompt (first time), successfully records audio, and produces a text transcription displayed in the GUI.
7. Do not break the existing local/dev workflow — the fix must work both when running locally and when deployed on the VPS.

Acceptance criteria: On the VPS deployment, clicking the record button prompts for microphone access (if not already granted), records audio, and displays the transcribed text in the GUI, matching the previously working local behavior.

## Strict Instructions for Cursor / Antigravity Agent
1. **Branching:** Create and switch to a new feature branch before editing code:
   `git checkout -b feature/task-1785232341271`
2. **Autonomy:** Run in non-interactive/auto-approve mode. Do NOT prompt for permission on file edits or terminal commands.
3. **Verification & Completion:**
   - Execute local quality gates (build/tests) and fix failures in a loop until green.
   - Stage all changes, commit them with a clean descriptive message, and push the branch to the remote origin.
   - Push the feature branch (no merge target configured).
4. **Do not delete PROMPT.md or .cursorrules** until after commit (E2E verifies them).

## Quality Gate Loop (MANDATORY — do not skip)
After implementing code changes you MUST locally verify before declaring done.
This catches TypeScript / Next.js / Vercel build failures before deploy.

### Verify commands (run from the matching package directory)
1. If `next_app/package.json` exists: `cd next_app && npm run build`
2. If `server/package.json` has a test script: `cd server && npm test`
3. If `mobile_app` has `typecheck` or `lint`: run that script
4. Otherwise run root `npm test` / `npm run build` when those scripts exist

### Fix loop
- If ANY command fails: read the error, fix the code, re-run the failing command.
- Repeat until ALL gates pass (up to ~5 fix iterations).
- Do NOT push a "done" state while `npm run build` (or equivalent) is red.
- Do NOT rely on Vercel/CI to discover type errors — catch them locally.

### Merge to deploy branch
- After gates are green: commit, push the feature branch, then merge into `Dev`.
- Example: `git checkout Dev && git pull && git merge --no-ff <feature-branch> -m "merge: <feature>" && git push origin Dev`
- Then return to the feature branch. Merging `Dev` triggers the production/Vercel build.
- If merge conflicts occur, resolve them, re-run quality gates, then finish the merge.

### Done criteria
- Local quality gates green
- Feature branch pushed
- Changes merged and pushed to `Dev`
