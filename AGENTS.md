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
- WhatsApp live ingest: shared `whatsapp-web.js` session with exponential reconnect (halt on LOGOUT), queued `message_create` ingest, raw `WhatsappMessage` persist, disk buffer if Mongo is down, caption+LID handling, one Chrome only (MCP uses the shared session). See `AUDIT_REPORT.md`.
- `POST /api/jobs/tracked-groups` persists the exact group name to `data/whatsapp-groups.json` (and Mongo if connected) even when WhatsApp is not authenticated. Live JID resolve is best-effort; `WA_GROUP_AMBIGUOUS` is still refused. Seed names also live in `config.json` `whatsapp.groups`.
