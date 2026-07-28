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

ENV NODE_ENV=development
COPY package.json package-lock.json ./
RUN npm install
ENV NODE_ENV=production

RUN npm install -g @anthropic-ai/claude-code

ENV PATH="/root/.local/bin:${PATH}"
RUN curl -fsSL https://cursor.com/install | bash \
  && ln -sf /root/.local/bin/agent /usr/local/bin/agent \
  && ln -sf /root/.local/bin/agent /usr/local/bin/cursor-agent \
  && ln -sf /root/.local/bin/agent /usr/local/bin/cursor \
  && agent --version || /root/.local/bin/agent --version

COPY . .

RUN mkdir -p /root/.claude /root/.cursor /root/.git-config-data /root/.local/bin /workspaces \
  && mkdir -p /app/data /app/assets /app/.wwebjs_auth

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    HEADLESS_BROWSER=true \
    CI=1 \
    CLAUDE_BIN=claude \
    CURSOR_BIN=agent \
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
