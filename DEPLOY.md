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
# | `voice-agent`      | `Dockerfile.app`              | HTTP API + PWA GUI + WhatsApp/jobs MCP (port 8787) |
# | `joinup-telegram`  | `Dockerfile.joinup-telegram`  | joinUp product Telegram bot (no public HTTP port) |
#
# Legacy: root `Dockerfile` matches `Dockerfile.app` for older Coolify configs.
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
# | `JOINUP_TELEGRAM_AUTOSTART` | Keep `0` — Telegram is a separate Coolify app |
# | Volumes | `.wwebjs_auth`, `data`, `assets`, Claude/Cursor/git config, `/workspaces` |
#
# ### joinup-telegram (`Dockerfile.joinup-telegram`)
#
# | Variable | Notes |
# |----------|-------|
# | `JOINUP_TELEGRAM_BOT_TOKEN` | Required |
# | `ALLOWED_TELEGRAM_USER_IDS` | Required (comma-separated) |
# | `JOINUP_PROJECT_ROOT` | Default `/workspaces/JoinUpApp` (registry id `joinup`) |
# | `VOICE_AGENT_URL` | **Required in Coolify** — full URL of the voice-agent app (e.g. `https://agent.example.com`). Live Cursor logs + activity history POST here. |
# | `JOINUP_RUN_LOG_URL` | Legacy alias for `VOICE_AGENT_URL` |
# | `GITHUB_TOKEN`, `VERCEL_*`, `RENDER_*` | Same as before for notify/redeploy |
# | Volumes | `data`, Claude/Cursor/git config, `/workspaces` (all coding clones) |
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
