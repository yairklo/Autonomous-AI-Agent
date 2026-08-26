# Voice Agent (app) — Coolify standalone application
# Playwright Node image includes Chromium OS dependencies for Linux containers.
# Use a published MCR tag (v1.62.0-jammy does not exist; v1.61.1-jammy is latest stable jammy).
FROM mcr.microsoft.com/playwright:v1.61.1-jammy

USER root

# Git / curl / compilers needed for Cursor agent repo edits and native npm builds
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
    build-essential \
    openssh-client \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV HOME=/root

# Skip Chrome during npm install, then install the revision Puppeteer pins.
# Playwright's image Chromium (Chrome 151) breaks whatsapp-web.js getChats /
# live events (evaluate error "r", no message_create).
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

# Install dependencies first for better layer caching.
# Use npm install (not npm ci) so Coolify builds tolerate lockfile
# cross-platform variations. Force development during install so Coolify's
# build-time NODE_ENV=production does not omit deps.
ENV NODE_ENV=development
COPY package.json package-lock.json ./
RUN npm install
ENV NODE_ENV=production

ENV PUPPETEER_SKIP_DOWNLOAD=false \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=false \
    PUPPETEER_CACHE_DIR=/opt/puppeteer-cache
RUN set -eux; \
  mkdir -p "$PUPPETEER_CACHE_DIR"; \
  PP=""; \
  if [ -x /app/node_modules/.bin/puppeteer ]; then \
    PP=/app/node_modules/.bin/puppeteer; \
  elif [ -x /app/node_modules/whatsapp-web.js/node_modules/.bin/puppeteer ]; then \
    PP=/app/node_modules/whatsapp-web.js/node_modules/.bin/puppeteer; \
  fi; \
  if [ -z "$PP" ]; then \
    echo "puppeteer CLI missing — installing puppeteer@24.38.0"; \
    npm install puppeteer@24.38.0 --no-save --no-fund --no-audit; \
    PP=/app/node_modules/.bin/puppeteer; \
  fi; \
  echo "using $PP"; \
  "$PP" browsers install chrome \
    || { sleep 4; "$PP" browsers install chrome; } \
    || PUPPETEER_DOWNLOAD_BASE_URL=https://cdn.npmmirror.com/binaries/chrome-for-testing \
      "$PP" browsers install chrome; \
  echo "=== puppeteer cache files ==="; \
  find "$PUPPETEER_CACHE_DIR" /root/.cache/puppeteer -type f \( -name chrome -o -name chrome-headless-shell \) 2>/dev/null || true; \
  CHROME="$(find "$PUPPETEER_CACHE_DIR" /root/.cache/puppeteer -type f -path '*/chrome-linux64/chrome' 2>/dev/null | head -n 1)"; \
  if [ -z "$CHROME" ]; then \
    CHROME="$(find "$PUPPETEER_CACHE_DIR" /root/.cache/puppeteer -type f -path '*/chrome-linux/chrome' 2>/dev/null | head -n 1)"; \
  fi; \
  if [ -z "$CHROME" ]; then \
    CHROME="$(find "$PUPPETEER_CACHE_DIR" /root/.cache/puppeteer -type f -name chrome 2>/dev/null | head -n 1)"; \
  fi; \
  echo "CHROME=${CHROME:-MISSING}"; \
  test -n "$CHROME"; \
  test -x "$CHROME"; \
  ln -sf "$CHROME" /usr/local/bin/wa-chrome; \
  /usr/local/bin/wa-chrome --no-sandbox --version
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

# Claude Code CLI (subscription / browser login — not API-key based)
RUN npm install -g @anthropic-ai/claude-code

ENV PATH="/root/.local/bin:${PATH}"
ENV HOME=/root

# Application source
COPY . .

# Ensure persistent dirs exist (workspaces mounted as named volume at runtime)
RUN mkdir -p /root/.claude /root/.git-config-data /root/.local/bin /workspaces \
  && mkdir -p /app/data /app/assets /app/.wwebjs_auth

# Production / Coolify runtime defaults (subscription CLIs; no API keys required)
# joinUp Telegram runs as a separate Coolify app (Dockerfile.joinup-telegram).
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    HEADLESS_BROWSER=true \
    CI=1 \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_CACHE_DIR=/opt/puppeteer-cache \
    PUPPETEER_EXECUTABLE_PATH=/usr/local/bin/wa-chrome \
    CLAUDE_BIN=claude \
    GIT_CONFIG_GLOBAL=/root/.git-config-data/gitconfig \
    NO_OPEN_BROWSER=1 \
    JOINUP_PROJECT_ROOT=/workspaces/JoinUpApp \
    JOINUP_GIT_REPO=https://github.com/yairklo/JoinUpApp.git \
    JOINUP_GITHUB_REPO=yairklo/JoinUpApp \
    AGENT_PROJECT_ROOT=/workspaces/Autonomous-AI-Agent \
    PORTFOLIO_PROJECT_ROOT=/workspaces/portfolio \
    ECODRIVE_PROJECT_ROOT=/workspaces/EcoDrive \
    WORKSPACE_BOOTSTRAP_STRICT=1 \
    IS_SANDBOX=1 \
    JOINUP_TELEGRAM_AUTOSTART=0 \
    WHATSAPP_AUTOSTART=1

EXPOSE 8787

CMD ["npm", "start"]
