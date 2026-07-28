# Cursor Task Execution Instruction

## Task Description
Bug: In the autonomous agent's GUI, the voice recording button does nothing — clicking it records no audio and produces no transcription. This started after migrating the deployment from local/dev hosting to a VPS. Investigate and fix, and produce a clear final written report (no manual browser testing will be done on my end — I need your written conclusion to be authoritative and precise).

Please determine and report:

1. Root cause: Is this caused by the browser blocking navigator.mediaDevices.getUserMedia because the GUI is now served over plain HTTP instead of HTTPS (browsers require a secure context — HTTPS or localhost — for microphone access)? Or is it a different/additional issue — broken WebSocket or HTTP endpoint for audio upload, CORS misconfiguration, wrong env var/URL still pointing at a localhost transcription service, mixed-content blocking (page loaded over HTTPS but calling an HTTP API), ws:// used where wss:// is now required, a missing/changed port in nginx or reverse proxy config after the VPS move, etc. Check the frontend JS (recording button event handler, any window.isSecureContext or getUserMedia usage, hardcoded URLs/schemes), the network calls it makes, and the backend endpoint/service that receives audio and returns a transcript.

2. Explicitly state whether the fix requires ONLY an infrastructure/deployment change (e.g., serving the GUI over HTTPS with a valid TLS cert, or adjusting reverse proxy/nginx config), or whether it ALSO requires a code change (e.g., hardcoded http:// or ws:// URLs, incorrect CORS headers, env vars still pointing at old local addresses, missing protocol upgrade logic). Do not assume — verify against the actual code and config in this repo.

3. If any code-level issue is found, fix it directly in the repo and describe exactly what changed and why.

4. If HTTPS is required and not yet configured on the VPS, do NOT attempt to provision certificates yourself. Instead, first check this repo's actual existing deployment setup (docker-compose, nginx config, Caddyfile, systemd units, etc. — whatever is actually there) and then give a precise, numbered, copy-pasteable step-by-step guide tailored to that real setup for moving the GUI to HTTPS (e.g., nginx + certbot/Let's Encrypt, or Caddy's automatic HTTPS, whichever fits what's already deployed). Do not give generic boilerplate instructions — base it on what's actually in the codebase.

5. Note explicitly if the recording code relies on window.isSecureContext or on a specific URL scheme, since that directly explains this symptom.

Acceptance criteria: I will consider this task done based on your written explanation alone — I will not personally re-test the recording feature. Be thorough and unambiguous about (a) root cause, (b) whether infra-only or infra+code changes are needed, and (c) exact next steps for me if any manual VPS/infra action is required on my side.

## Strict Instructions for Cursor / Antigravity Agent
1. **Branching:** Create and switch to a new feature branch before editing code:
   `git checkout -b feature/task-1785233979675`
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
