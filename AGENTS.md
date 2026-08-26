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
- WhatsApp live ingest (`whatsapp-web.js` + Puppeteer, not Baileys) has no reconnect/backoff; `disconnected` only sets state and `start()` may `initialize()` a dead Client. HTTP path listens to `message_create` and writes Mongo `Job` only (no raw WA messages, no Telegram). `textOnly` skips media captions; `@lid` from-ids are dropped unless `to` is `@g.us`. MCP watcher is a second Client on the same LocalAuth dir. See `AUDIT_REPORT.md`.
