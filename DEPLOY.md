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
# | Volumes | `.wwebjs_auth`, `data`, `assets`, Claude/Cursor/git config, `/workspaces` |
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
