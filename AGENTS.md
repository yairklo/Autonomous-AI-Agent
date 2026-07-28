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
