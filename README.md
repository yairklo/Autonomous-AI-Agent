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

Line-by-line Claude Orchestrator in the terminal. Coding tasks stay in **Grill-Me Mode** (clarifying questions) until you confirm with e.g. `skip Grill-Me Mode and dispatch` / `שגר ל-Cursor`, which invokes `dispatch_coding_task`. Use `npm run chat:mock` without Claude auth. If the server is not already up, `chat` starts it for you.

For the planned WhatsApp jobs + CV tool, Grill-Me uses pack `whatsapp-jobs-cv` (`GET /api/grill-me/packs/whatsapp-jobs-cv?format=reply&locale=he`). See `specs/whatsapp-jobs-cv-grill-me.md`.

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

See [DECISIONS.md](./DECISIONS.md) for why.

## API

### `GET /api/health`
LAN addresses, mock flag, Whisper availability.

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

## Project layout

```
server/          Express + Claude session + STT/TTS helpers
client/          PWA (HTML/CSS/JS, service worker)
scripts/         smoke-test.js
TODO.md          Task tracker
DECISIONS.md     Architecture decisions
```

## Security

MVP assumes a **trusted LAN or Tailscale** network. There is no auth layer. Do not expose port 8787 to the public internet.
