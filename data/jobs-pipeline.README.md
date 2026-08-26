# WhatsApp Jobs CV Pipeline (local MCP)

Local-only pipeline integrated as MCP tools in the voice agent:

1. **Scan** — `whatsapp-web.js` realtime listen (groups from root `config.json` only) or export fallback
2. **Match** — Full Stack / Backend (HE/EN), dedupe in `data/jobs-db.json`
3. **Notify** — Telegram with **Approve** / **Reject** buttons
4. **Approve → Submit** — tapping Approve in Telegram is what triggers the Playwright form fill (never WhatsApp DM/group send). This is handled by a background long-poller (`server/jobs/telegram-poll.js`, started from `server/index.js` at boot) that listens for the button tap and calls `submitApprovedJob` automatically — Reject just marks the job rejected.

The Mongo `Job` collection (used by `/api/jobs/recent`) mirrors this same status as it moves through approval/submission (`server/jobs-engine/job-store.js:syncMongoJobStatus`) — the JSON `data/jobs-db.json` file remains the source of truth for approval/submission itself.

Cover letters use the Gemini API (`GEMINI_API_KEY`) when `submission.llmCoverLetter` is `true` in `config.json`, falling back to the profile's `coverTemplateHe`/`coverTemplateEn` template when no key is set or the call fails. LLM generation only runs for a real (non-dry-run) submit.

## Safety

- Never send messages in WhatsApp groups
- Never submit without Telegram Approve
- Storage is local only
- `submit_manual_job_link` (chat/voice tool for a one-off URL the user pastes) defaults to dry-run; it only performs a real submit when called with `confirm: true`

## Config

See root `config.json`. Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in the environment.

Group allow-list: `config.json` → `whatsapp.groups`, overridable via GUI (Settings) which writes `data/whatsapp-groups.json`.

Only one process should long-poll Telegram `getUpdates` for a given bot token at a time (Telegram itself enforces this — a second concurrent poller gets `409 Conflict`), so run a single voice-agent instance per `TELEGRAM_BOT_TOKEN`. On its very first run, the poller skips any backlog of pre-existing updates (e.g. old button taps from before this poller existed) instead of acting on them — see `data/telegram-update-offset.json`.

## Connect WhatsApp (VPS / Docker)

```bash
npm run whatsapp:connect
# or: docker exec -it <voice-agent> npm run whatsapp:connect
# optional: npm run whatsapp:groups   # list group names after QR scan
```

Persist `.wwebjs_auth` as a volume so you do not re-scan after every redeploy.
