# Agent memory

Persistent instructions for Cursor Agent (including headless terminal runs).

## Always
- Read `PROMPT.md`, `.cursorrules`, `AGENTS.md`, and `.cursor/rules/`.
- Run local production build/tests after code changes; fix until green.
- Append new deploy/type lessons here when you discover them.

## Lessons learned (auto)
- Quality gate `root:test` failed — re-run and fix locally before merge/deploy.
- `npm start` can fail hard on duplicate ESM imports (for example `fs` in `server/index.js`) even when tests pass; rerun startup locally after server entry changes.
- Voice GUI push-to-talk needs a browser secure context (`window.isSecureContext`). Plain `http://VPS-IP:8787` after Coolify/VPS migrate blocks `getUserMedia` / Web Speech; enable Coolify domain + Let’s Encrypt HTTPS (no repo nginx/Caddyfile). Client must check `isSecureContext` and not silently ignore `SpeechRecognition.onerror` without MediaRecorder fallback.
- Gemini orchestration: with `GEMINI_API_KEY` set (and no `AGENT_LLM_PROVIDER` override), the voice/joinUp chat backend uses `GeminiSessionManager` (`gemini-3.6-flash` by default from live discovery). MCP tools remain server-side. Free-tier calls go through `GeminiRateLimiter` (RPM spacing + 429 backoff). Discover models with `node scripts/list-google-models.js`.
- WhatsApp live ingest: shared `whatsapp-web.js` session with exponential reconnect (halt on LOGOUT **and** Chrome launch failure). Docker must use Playwright **v1.50.1-jammy** (Chromium ~133), not 1.61.1 / Chrome 151 — that breaks `getChats` (`error: "r"`) and `message_create`. Do not download Chrome at build time on Coolify. Do not `npm install -g @anthropic-ai/claude-code` in the image (ships `claude.exe`, Coolify unpack hits `no space left on device`); use `npm install --omit=dev`. If Coolify export fails on overlayfs, prune builder/images on the **server** (never `--volumes`). Raw persist includes 1:1 / Message yourself (`אני`); job matching still uses tracked/allow-list. If `getChat` fails, ingest used to store the JID as `chatName` and then skip `group_not_tracked` even for allow-listed groups — seed the chat-id→name cache from `getChats` on ready and never cache empty group names. `GET /api/whatsapp/messages` lists captured bodies.
- `POST /api/jobs/tracked-groups` persists the exact group name to `data/whatsapp-groups.json` (and Mongo if connected) even when WhatsApp is not authenticated. Live JID resolve is best-effort; `WA_GROUP_AMBIGUOUS` is still refused. Seed names also live in `config.json` `whatsapp.groups`.
