# Playwright Node image includes Chromium OS dependencies for Linux containers.
# Keep this tag aligned with package-lock.json playwright version.
FROM mcr.microsoft.com/playwright:v1.62.0-jammy

WORKDIR /app

# Install dependencies first for better layer caching
COPY package.json package-lock.json ./
RUN npm ci

# Application source
COPY . .

# Production defaults for Coolify / Docker
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    HEADLESS_BROWSER=true

EXPOSE 8787

CMD ["npm", "start"]
