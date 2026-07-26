# WhatsApp Jobs CV Pipeline (local MCP)

Local-only pipeline integrated as MCP tools in the voice agent:

1. **Scan** — `whatsapp-web.js` realtime listen (groups from root `config.json` only) or export fallback
2. **Match** — Full Stack / Backend (HE/EN), dedupe in `data/jobs-db.json`
3. **Notify** — Telegram with **Approve** / **Reject** buttons
4. **Submit** — Playwright form fill only after Approve (never WhatsApp DM/group send)

## Safety

- Never send messages in WhatsApp groups
- Never submit without Telegram Approve
- Storage is local only

## Config

See root `config.json`. Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in the environment.
