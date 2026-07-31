# Backward-compatible default image for Coolify / local builds.
# Canonical Coolify apps:
#   - Dockerfile.app              → voice-agent (HTTP :8787 + GUI + WhatsApp/jobs)
#   - Dockerfile.joinup-telegram  → joinUp Telegram product bot
#
# Prefer setting Coolify "Dockerfile Location" to Dockerfile.app explicitly.
# Playwright Node image includes Chromium OS dependencies for Linux containers.
FROM mcr.microsoft.com/playwright:v1.61.1-jammy

USER root

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
    build-essential \
    openssh-client \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Skip Puppeteer's Chrome download — use Playwright image Chromium instead
# (avoids flaky Google CDN downloads + corrupt partial cache folders on Coolify).
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

ENV NODE_ENV=development
COPY package.json package-lock.json ./
RUN npm install
ENV NODE_ENV=production

# Point whatsapp-web.js / puppeteer at Playwright's preinstalled Chromium.
RUN CHROME="$(find /ms-playwright -type f \( -path '*/chrome-linux/chrome' -o -path '*/chrome-linux64/chrome' \) 2>/dev/null | head -n 1)" \
  && test -n "$CHROME" \
  && test -x "$CHROME" \
  && ln -sf "$CHROME" /usr/local/bin/wa-chrome \
  && /usr/local/bin/wa-chrome --version

RUN npm install -g @anthropic-ai/claude-code

ENV PATH="/root/.local/bin:${PATH}"
ENV HOME=/root

COPY . .

RUN mkdir -p /root/.claude /root/.git-config-data /root/.local/bin /workspaces \
  && mkdir -p /app/data /app/assets /app/.wwebjs_auth

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
    JOINUP_TELEGRAM_AUTOSTART=0

EXPOSE 8787

CMD ["npm", "start"]
