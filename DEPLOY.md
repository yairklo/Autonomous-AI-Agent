# Coolify deployment (independent Docker applications)
#
# Deploy each service as its **own Coolify application** so CPU/RAM metrics
# appear separately in the Coolify UI. Do not use a single Compose stack on
# Coolify for production metrics isolation.
#
# ## Applications
#
# | Coolify app name   | Dockerfile                    | Role |
# |--------------------|-------------------------------|------|
# | `voice-agent`      | `Dockerfile.app`              | HTTP API + PWA GUI + WhatsApp/jobs MCP + **joinUp brain** (`/api/joinup/*`) |
# | `joinup-telegram`  | `Dockerfile.joinup-telegram`  | Thin Telegram I/O only (no Claude/Cursor in this container) |
#
# Legacy: root `Dockerfile` matches `Dockerfile.app` for older Coolify configs.
#
# ## Architecture (thin Telegram bot)
#
# Telegram → joinup-telegram (allow-list) → `VOICE_AGENT_URL` `/api/joinup/*`
# voice-agent runs Grill-Me (Claude) + Cursor dispatch pinned to JoinUp.
# `POST /api/joinup/dispatch` returns **202 + runId**; the bot polls
# `GET /api/joinup/runs/:runId` until completed/failed (avoids HTTP 504).
# Auth: shared `JOINUP_BOT_SHARED_SECRET` via header `X-JoinUp-Bot-Secret`
# (compared with `crypto.timingSafeEqual`).
# ## HTTPS required for microphone / push-to-talk (voice-agent GUI)
#
# There is **no nginx.conf / Caddyfile / certbot config in this repo**. TLS is
# terminated by **Coolify’s reverse proxy** (Traefik/Caddy under the hood) when
# you attach a domain + Let’s Encrypt to the `voice-agent` application.
# The Node process still listens on plain HTTP `:8787` inside the container;
# Coolify publishes HTTPS on 443 externally.
#
# Browsers only expose `navigator.mediaDevices.getUserMedia` and Web Speech in a
# **secure context** (`https://` or `http://localhost`). Opening
# `http://<VPS-IP>:8787` after the move from local/dev therefore makes the PTT
# button appear to do nothing (`window.isSecureContext === false`).
#
# ### Copy-paste Coolify steps (voice-agent app)
#
# 1. Point a DNS A/AAAA record at your VPS public IP, e.g. `agent.example.com`.
# 2. In Coolify → **voice-agent** application → **Settings** / **Domains**:
#    add `agent.example.com` (or your chosen host).
# 3. Enable **Generate SSL certificate** / Let’s Encrypt for that domain
#    (Coolify UI wording varies slightly by version; leave HTTP→HTTPS redirect on).
# 4. Confirm the app’s expose/port mapping still targets container port **8787**
#    (`EXPOSE 8787` / `PORT=8787` in `Dockerfile.app`). Do **not** put TLS inside
#    the Node app; Coolify terminates TLS and proxies to `http://container:8787`.
# 5. Redeploy / wait until the certificate status is healthy.
# 6. Open **`https://agent.example.com`** (not `http://IP:8787`). In DevTools
#    console, `window.isSecureContext` must be `true` before using Hold to talk.
# 7. On the **joinup-telegram** Coolify app, set
#    `VOICE_AGENT_URL=https://agent.example.com` (no trailing slash required;
#    code trims it). Redeploy Telegram so live logs / history POST to HTTPS.
# 8. In the PWA **Settings → Base URL**, leave blank for same-origin, or set the
#    same `https://…` URL. Never keep an `http://…` Base URL while the page is
#    loaded over HTTPS (mixed content blocks uploads).
#
# Local optional Compose (`docker-compose.yaml`) stays HTTP on `localhost:8787`,
# which browsers treat as a secure context — mic keeps working for local smoke.
#
# ## Shared / required environment variables
#
# ### voice-agent (`Dockerfile.app`)
#
# | Variable | Notes |
# |----------|-------|
# | `HOST` / `PORT` | Default `0.0.0.0:8787` |
# | `HEADLESS_BROWSER` | `true` in containers |
# | `GITHUB_TOKEN` | Clone/push **all** workspaces in `workspaces.json` (agent, JoinUp, portfolio, EcoDrive) |
# | `AGENT_PROJECT_ROOT` | Default `/workspaces/Autonomous-AI-Agent` (self-coding; not `/app`) |
# | `PORTFOLIO_PROJECT_ROOT` | Default `/workspaces/portfolio` |
# | `ECODRIVE_PROJECT_ROOT` | Default `/workspaces/EcoDrive` |
# | `JOINUP_BOT_SHARED_SECRET` | **Required** — must match joinup-telegram |
# | `JOINUP_PROJECT_ROOT` | Default `/workspaces/JoinUpApp` (Cursor pin for joinUp) |
# | `JOINUP_TELEGRAM_AUTOSTART` | Keep `0` — Telegram is a separate Coolify app |
# | `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | Jobs approval bot (inside app) |
# | `JOINUP_TELEGRAM_AUTOSTART` | Keep `0` — Telegram is a separate Coolify app. Alone it no longer starts the bot; embedded mode also needs `JOINUP_TELEGRAM_ALLOW_EMBEDDED=1` (local only). |
# | Volumes | `.wwebjs_auth`, `data`, `assets`, Claude/Cursor/git config, `/workspaces` |
# | WhatsApp / Puppeteer | Playwright image for OS libs; Chrome binary is Puppeteer's pinned build (`npx puppeteer browsers install chrome` → `/usr/local/bin/wa-chrome`). Do not point `PUPPETEER_EXECUTABLE_PATH` at Playwright Chrome 151. |
#
# ### joinup-telegram (`Dockerfile.joinup-telegram`) — thin
#
# | Variable | Notes |
# |----------|-------|
# | `JOINUP_TELEGRAM_BOT_TOKEN` | Required |
# | `ALLOWED_TELEGRAM_USER_IDS` | Required (comma-separated) |
# | `VOICE_AGENT_URL` | **Required** — HTTPS URL of voice-agent |
# | `JOINUP_BOT_SHARED_SECRET` | **Required** — same value as voice-agent |
# | Volumes | `/app/data` only (no Claude/Cursor/`/workspaces` needed) |
#
# ## Coding workspaces (`workspaces.json`)
#
# Cursor dispatch never uses the Docker image tree `/app` (no `.git`). Bootstrap
# clones each registry entry under `/workspaces`. Chat/GUI default =
# `autonomous-agent`. JoinUp Telegram stays pinned to `joinup` with
# `mergeTarget=Dev`. Add a repo later by appending an entry to `workspaces.json`
# and ensuring `GITHUB_TOKEN` can read/write that repo.
# ## Network communication
#
# Services talk **only** via configurable URLs/ports in env vars:
#
# - `VOICE_AGENT_URL` (preferred) or `JOINUP_RUN_LOG_URL`
# - Optional fallbacks: `JOINUP_RUN_LOG_HOST` + `VOICE_AGENT_PORT` (local only)
#
# Do **not** hardcode Docker Compose service DNS names in application code.
# Compose may still set `VOICE_AGENT_URL=http://app:8787` for local multi-container smoke tests.
#
# ## One-time CLI auth (each app container)
#
# ```bash
# npm run auth:cli
# ```
#
# Set `GITHUB_TOKEN` in Coolify for non-interactive git.
#
# ## Local optional Compose
#
# `docker-compose.yaml` can build both images for wiring checks:
#
# ```bash
# docker compose build
# docker compose up app
# # joinup-telegram needs JOINUP_TELEGRAM_* secrets in the environment
# ```
#
# Production Coolify: create **two** applications pointing at the two Dockerfiles above.
