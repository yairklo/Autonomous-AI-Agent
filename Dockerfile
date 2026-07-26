# Playwright Node image includes Chromium OS dependencies for Linux containers.
# Keep this tag aligned with package-lock.json playwright version.
FROM mcr.microsoft.com/playwright:v1.62.0-jammy

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

# Install app dependencies first for better layer caching
COPY package.json package-lock.json ./
RUN npm ci

# Claude Code CLI (subscription / browser login — not API-key based)
RUN npm install -g @anthropic-ai/claude-code

# Cursor Agent CLI → ~/.local/bin/agent (subscription / browser login)
ENV PATH="/root/.local/bin:${PATH}"
RUN curl -fsSL https://cursor.com/install | bash \
  && ln -sf /root/.local/bin/agent /usr/local/bin/agent \
  && ln -sf /root/.local/bin/agent /usr/local/bin/cursor-agent \
  && ln -sf /root/.local/bin/agent /usr/local/bin/cursor \
  && agent --version || /root/.local/bin/agent --version

# Application source
COPY . .

# Ensure git-config volume directory exists (file is created on first auth:cli)
RUN mkdir -p /root/.claude /root/.cursor /root/.git-config-data /root/.local/bin

# Production / Coolify defaults (subscription CLIs; no API keys required)
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    HEADLESS_BROWSER=true \
    CI=1 \
    CLAUDE_BIN=claude \
    CURSOR_BIN=agent \
    GIT_CONFIG_GLOBAL=/root/.git-config-data/gitconfig \
    NO_OPEN_BROWSER=1

EXPOSE 8787

CMD ["npm", "start"]
