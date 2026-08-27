# Voice Agent (app) — Coolify standalone application
# Playwright Node image includes Chromium OS dependencies for Linux containers.
# Pin 1.50.x (Chromium ~133). 1.61.1 ships Chrome 151 which breaks
# whatsapp-web.js getChats / message_create (evaluate error "r").
FROM mcr.microsoft.com/playwright:v1.50.1-jammy

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

# Skip Puppeteer's Chrome download — use the image Chromium (pinned ~133).
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

# Production deps only. Coolify VPS ran out of disk unpacking promptfoo and
# the global Claude CLI package (it ships claude.exe). Gemini does not need
# that CLI at build time; install it later on the running container if required.
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm install --omit=dev --no-audit --no-fund

RUN CHROME="$(find /ms-playwright -type f \( -path '*/chrome-linux/chrome' -o -path '*/chrome-linux64/chrome' \) 2>/dev/null | head -n 1)" \
  && test -n "$CHROME" \
  && test -x "$CHROME" \
  && ln -sf "$CHROME" /usr/local/bin/wa-chrome \
  && /usr/local/bin/wa-chrome --no-sandbox --version

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
