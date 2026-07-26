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

# Install dependencies first for better layer caching.
# Coolify often injects NODE_ENV=production at build time, which would skip
# devDependencies — force a full install, then switch to production for runtime.
COPY package.json package-lock.json ./
RUN npm ci --include=dev

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

# Ensure persistent dirs exist (workspaces mounted as named volume at runtime)
RUN mkdir -p /root/.claude /root/.cursor /root/.git-config-data /root/.local/bin /workspaces

# Production / Coolify runtime defaults (subscription CLIs; no API keys required)
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
    WORKSPACE_BOOTSTRAP_STRICT=1

EXPOSE 8787

CMD ["npm", "start"]
