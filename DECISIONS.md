# Architecture Decisions

## D20 — Coolify: one Dockerfile application per service
**Decision:** Deploy `Dockerfile.app` (voice-agent) and `Dockerfile.joinup-telegram` as separate Coolify applications instead of a single Compose stack for production. Inter-service traffic uses explicit env URLs (`VOICE_AGENT_URL` / `JOINUP_RUN_LOG_URL`), not hard-coded Compose DNS aliases. Root `Dockerfile` stays as a backward-compatible alias of `Dockerfile.app`. Optional `docker-compose.yaml` can still wire both locally.  
**Why:** Coolify surfaces CPU/RAM per application; a unified Compose service hides which process is heavy.  
**Env:** `VOICE_AGENT_URL`, `JOINUP_RUN_LOG_URL`, `JOINUP_TELEGRAM_AUTOSTART=0`  
**Date:** 2026-07-27

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

## D14 — E2E dispatch test must run in isolation
**Decision:** `scripts/test-task-dispatch-e2e.js` refuses to start when port 8787 is already listening. Prefer `npm test` (unit tests, including MCP execute stub) when a live voice-agent is up.  
**Why:** Nesting dispatch against a parent SSE chat kills the outer stream.  
**Date:** 2026-07-24

## D15 — Grill-Me Mode default for interactive chat
**Decision:** Interactive conversations use Grill-Me Mode by default (system prompt). Server auto-dispatch via `dispatch_coding_task` runs only when the user explicitly skips Grill-Me or confirms dispatch (`skip Grill-Me Mode` / `דלג על Grill-Me` / `שגר ל-Cursor`). Ordinary coding utterances go to Claude for clarifying questions. Terminal UX: `npm run chat` (`scripts/interactive-chat.js`).  
**Why:** Scope, requirements, profile structure, and approval workflows must be refined before headless Cursor work starts.  
**Date:** 2026-07-26

## D16 — Conversational Grill-Me never auto-fires MCP / Cursor
**Decision:** Utterances like "שאל אותי", "Grill-Me Pack", or "ask me questions" are classified as interactive conversation (`isInteractiveConversationRequest`). They skip auto `dispatch_coding_task`, `scan_whatsapp_jobs`, and `submit_whatsapp_job_cv` so Claude interviews the user in-chat; Cursor/tools run only after explicit end-of-dialogue confirmation.  
**Why:** Sending Grill-Me questioning to headless Cursor fails — Cursor cannot talk back to the user.  
**Date:** 2026-07-26

## D17 — Chat refuses / replaces stale voice-agent without grillMeConversation
**Decision:** `/api/health` exposes `grillMeConversation: true`. `npm run chat` connects only to servers that advertise it; otherwise it frees the port and starts a fresh local server (`--restart` / `npm run chat:restart` forces replace).  
**Why:** An old process on :8787 still matched bare "Grill-Me" and dispatched to Cursor while the updated client thought it was fine.  
**Date:** 2026-07-26

## D18 — WhatsApp jobs/CV Grill-Me pack (questionnaire bank)
**Decision:** Domain clarifying questions for WhatsApp job-scan + CV-submit live in `server/grill-me-packs.js` (pack id `whatsapp-jobs-cv`). Interactive "שאל אותי / Grill-Me Pack" requests serve `formatGrillMeReply` via `/api/chat` (and mock Claude); `GET /api/grill-me/packs/:packId` exposes reply/spec/json. System prompt steers live Claude with the same domain themes.  
**Why:** Deterministic questionnaire for scope, WA access, matching, profile, submit, approval, and privacy — without dispatching interview work to headless Cursor.  
**Date:** 2026-07-26

## D16 — WhatsApp job scan via local chat exports (MCP)
**Decision:** Job scanning is exposed as MCP tool `scan_whatsapp_jobs` (`server/mcp-tools.js` + `server/whatsapp-job-scanner.js`). v1 reads WhatsApp **Export chat** `.txt` files from `data/whatsapp-exports` (or an explicit `exportPath`); no live WhatsApp Web/Baileys client. Hebrew/English keyword scoring finds posts; optional `roles` boost relevance. Chat orchestration auto-invokes the tool when the user asks to scan WhatsApp groups for jobs (`detectWhatsappJobScan`). Empty export dir falls back to `fixtures/whatsapp` for demos/tests. Job results include extracted `contacts` (email/phone/URL).  
**Why:** Local exports keep privacy and avoid QR/session complexity while still giving the agent a real, testable scan tool.  
**Env:** `WHATSAPP_EXPORTS_DIR`, `AUTO_SCAN_WHATSAPP_JOBS`  
**Date:** 2026-07-26

## D17 — CV submit drafts for WhatsApp jobs (MCP)
**Decision:** CV applications are exposed as MCP tool `submit_whatsapp_job_cv` (`server/cv-submitter.js`). v1 writes local draft packages under `data/cv-applications` (JSON + cover note + CV copy) and a `mailto:` URI when an email is found. Live WhatsApp send is out of scope. Candidate data comes from `CV_PROFILE_PATH` (falls back to `fixtures/cv/profile.json`). Orchestration auto-invokes on submit intent (`detectWhatsappCvSubmit`); if no job text/email is given, it resolves the top scanned job with an email. `confirm=true` only marks `ready_to_send` after explicit user approval.  
**Why:** Completes scan→propose→approve→draft without requiring a live WA client or silent outbound messages.  
**Env:** `CV_PROFILE_PATH`, `CV_APPLICATIONS_DIR`, `AUTO_SUBMIT_WHATSAPP_CV`  
**Date:** 2026-07-26

## D19 — WhatsApp jobs pipeline via local MCP (whatsapp-web.js + Telegram + Playwright)
**Decision:** Full Grill-Me answers are implemented as local MCP tools in the agent (`server/mcp-tools.js` + `server/jobs/*`). Groups come only from root `config.json`. Realtime listen uses `whatsapp-web.js` (listen-only; sends hard-blocked). Matching targets Full Stack/Backend HE/EN with local JSON DB dedupe (`data/jobs-db.json`). Telegram Approve/Reject is mandatory before Playwright form submit (`submit_job_form`). No WhatsApp DMs/group replies. Profile: name, email, phone, linkedin, github, `assets/cv.pdf`. Cover letter LLM-adapted with template fallback; delay between submissions; Telegram alert on failure. Storage local only.  
**Why:** Matches approved architecture option 4 (MCP Tool מקומי המשולב בסוכן) and safety constraints.  
**Env:** `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`  
**Date:** 2026-07-26
