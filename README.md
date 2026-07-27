# Voice Agent MVP

Personal **mobile voice agent** that talks to a **local server** running **Claude CLI**.

```
Phone (PWA)  --LAN/Tailscale-->  Node server  -->  claude -p --resume
   STT (Web Speech)                 SSE stream         continuous session
   TTS (SpeechSynthesis)
```

## Quick start

```bash
npm install
npm start
```

### Interactive terminal chat (Grill-Me Mode)

```bash
npm run chat
```

Line-by-line Claude Orchestrator in the terminal. Coding tasks stay in **Grill-Me Mode** (clarifying questions) until you confirm with e.g. `skip Grill-Me Mode and dispatch` / `שגר ל-Cursor`, which invokes `dispatch_coding_task`. Asking for the **WhatsApp + CV Grill-Me Pack** (`שאל אותי … Grill-Me Pack`) serves the domain questionnaire in-chat — it does not open Cursor. Use `npm run chat:mock` without Claude auth. If the server is not already up, `chat` starts it for you.

Open on your phone (same LAN or Tailscale):

`http://<your-pc-ip>:8787`

1. Allow microphone when prompted.
2. **Hold** the big button, speak, **release** to send.
3. Replies stream in and are spoken aloud.

### Mock mode (no Claude auth required)

```bash
npm run mock
npm run smoke
```

## Architecture

| Layer | Choice |
|-------|--------|
| Backend | Node.js + Express on `0.0.0.0:8787` |
| Claude | `claude -p --output-format stream-json` + `--resume` |
| STT | Client Web Speech API (primary); optional Whisper via `WHISPER_BIN` |
| TTS | Client `speechSynthesis` (primary); optional `POST /api/tts` |
| Client | Installable PWA with Push-to-Talk |
| MCP tools | `dispatch_coding_task`, `scan_whatsapp_jobs`, `submit_whatsapp_job_cv` |

See [DECISIONS.md](./DECISIONS.md) for why.

## API

### `GET /api/health`
LAN addresses, mock flag, Whisper availability, Grill-Me pack ids.

### `GET /api/grill-me/packs`
Lists domain Grill-Me packs (e.g. `whatsapp-jobs-cv`).

### `GET /api/grill-me/packs/:packId`
Query: `locale=he|en`, `format=json|reply|spec`. Returns the pack JSON, a chat-ready questionnaire (`reply`), or an empty markdown scaffold (`spec`).

### Cursor Live logs
- Terminal: while Cursor runs, the server prints `[run:…]` lines (status / tool / git / errors).
- GUI: open the PWA — **Cursor Live** panel streams `/api/runs/stream`.
- joinUp Telegram bot forwards the same logs to the server via `/api/runs/events` (keep `npm start` running).

### `POST /api/chat` (SSE)
```json
{ "clientId": "device-uuid", "text": "What's on my calendar logic today?" }
```
Events: `meta`, `token`, `session`, `done`, `error`.

### `POST /api/chat/sync`
Same body; JSON response for **iOS Shortcuts** / **Tasker**:
```json
{ "clientId": "...", "sessionId": "...", "text": "..." }
```

### `POST /api/voice` (SSE, multipart)
Fields: `clientId`, optional `text`, optional file `audio`.

### `POST /api/session/reset`
```json
{ "clientId": "..." }
```

### `POST /api/tts`
```json
{ "text": "Hello" }
```
Returns `audio/wav` when a local engine works (Windows SAPI / macOS `say` / espeak).

## Configuration

| Env | Default | Meaning |
|-----|---------|---------|
| `HOST` | `0.0.0.0` | Bind address (LAN/Tailscale) |
| `PORT` | `8787` | HTTP port |
| `CLAUDE_BIN` | `claude` | Claude CLI path |
| `VOICE_AGENT_MOCK` | `0` | `1` = canned replies |
| `WHISPER_BIN` | — | whisper.cpp binary for server STT |
| `WHISPER_MODEL` | — | Model path for whisper.cpp |
| `VOICE_SYSTEM_PROMPT` | (built-in) | Override voice persona |
| `CLAUDE_TIMEOUT_MS` | `300000` | Per-turn timeout |
| `WHATSAPP_EXPORTS_DIR` | `data/whatsapp-exports` | WhatsApp `.txt` chat exports for `scan_whatsapp_jobs` |
| `AUTO_SCAN_WHATSAPP_JOBS` | `1` | Auto-invoke `scan_whatsapp_jobs` on scan intent |
| `CV_PROFILE_PATH` | `data/cv-profile.json` | Candidate profile JSON (falls back to `fixtures/cv`) |
| `CV_APPLICATIONS_DIR` | `data/cv-applications` | Draft CV application packages |
| `AUTO_SUBMIT_WHATSAPP_CV` | `1` | Auto-invoke `submit_whatsapp_job_cv` on apply intent |
| `JOINUP_TELEGRAM_BOT_TOKEN` | — | Dedicated Telegram bot token for joinUp collaborators |
| `ALLOWED_TELEGRAM_USER_IDS` | — | Comma-separated Telegram user IDs allow-list |
| `JOINUP_PROJECT_ROOT` | `C:\JoinUpApp` | Absolute path to the joinUp repo (execution is pinned here) |
| `JOINUP_TELEGRAM_MOCK` | `0` | `1` = mock product grilling (no Claude) |
| `JOINUP_TELEGRAM_AUTOSTART` | `0` | `1` = start joinUp bot with `npm start` |

### joinUp Telegram Product Bot

Dedicated bot for **non-technical collaborators** to specify joinUp features. It grills for product/UX details, asks for explicit confirmation, then dispatches a Cursor Agent run **only** against `JOINUP_PROJECT_ROOT`.

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy the token.
2. Add to `.env` (see [.env.example](./.env.example)):

```bash
JOINUP_TELEGRAM_BOT_TOKEN=123456:ABC...
ALLOWED_TELEGRAM_USER_IDS=11111111,22222222
JOINUP_PROJECT_ROOT=C:\JoinUpApp
```

3. Run:

```bash
npm run joinup:telegram
```

Unauthorized Telegram users are rejected. Coding execution never leaves the joinUp project directory.

### WhatsApp job scanning

1. In WhatsApp, open a jobs group → **Export chat** → **Without media**.
2. Place the `.txt` file in `data/whatsapp-exports/` (or pass `exportPath`).
3. Ask the agent: `תסרוק משרות בקבוצות WhatsApp` / `Scan WhatsApp groups for jobs`.

The MCP tool `scan_whatsapp_jobs` scores Hebrew/English hiring signals and returns matches (with emails/phones/URLs when present). If the exports folder is empty, a bundled fixture is used for demos.

### CV application drafts

1. Copy `data/cv-profile.example.json` → `data/cv-profile.json` and set your name, email, and `cvPath`.
2. After a scan (or with a quoted job / email), ask: `הגש קו״ח` / `Submit CV to jobs@example.com`.
3. The MCP tool `submit_whatsapp_job_cv` writes a draft under `data/cv-applications/` and a `mailto:` link. It never sends live WhatsApp messages; say `אשר הגשה` / `confirm` to mark `ready_to_send`.

Copy [.env.example](./.env.example) as a checklist (export vars in your shell; no dotenv required).

## Tailscale

1. Install Tailscale on the PC and phone.
2. `npm start` on the PC.
3. On the phone, open `http://<tailscale-ip>:8787` (or set that URL in **Settings**).

## iOS Shortcut / Tasker

Point an HTTP POST action at:

`http://<host>:8787/api/chat/sync`

Body (JSON):

```json
{ "clientId": "iphone", "text": "Spoken text from Shortcuts dictation" }
```

Use the returned `text` field with Speak Text / TTS.

## Deployment (Coolify)

Deploy **two independent Docker applications** (separate CPU/RAM in Coolify UI):

| App | Dockerfile | Entrypoint |
|-----|------------|------------|
| voice-agent | `Dockerfile.app` | `npm start` (:8787) |
| joinup-telegram | `Dockerfile.joinup-telegram` | `npm run start:joinup-telegram` |

Set `VOICE_AGENT_URL` on the Telegram app to the voice-agent public/private URL so Cursor Live logs bridge over HTTP. See [DEPLOY.md](./DEPLOY.md).

`docker-compose.yaml` remains an optional local multi-service helper; prefer per-Dockerfile Coolify apps in production.

## Project layout

```
server/                 Express + Claude session + STT/TTS helpers
server/joinup-telegram/ Dedicated joinUp collaborator Telegram bot
client/                 PWA (HTML/CSS/JS, service worker)
scripts/                smoke-test.js, joinup-telegram-bot.js
Dockerfile.app          Coolify voice-agent image
Dockerfile.joinup-telegram  Coolify joinUp Telegram image
DEPLOY.md               Coolify multi-app env + networking
DECISIONS.md            Architecture decisions
```

## Security

MVP assumes a **trusted LAN or Tailscale** network. The voice HTTP API has no auth layer — do not expose port 8787 to the public internet.

The joinUp Telegram bot is allow-list gated via `ALLOWED_TELEGRAM_USER_IDS` and pins Cursor Agent execution to `JOINUP_PROJECT_ROOT` only.
