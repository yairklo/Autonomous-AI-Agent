/**
 * Puppeteer launch options for whatsapp-web.js inside Docker/Coolify.
 *
 * Prefer Chrome installed at build time (`npx puppeteer browsers install chrome`).
 * Optional override: PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
 */
export function buildWhatsappPuppeteerOpts(env = process.env) {
  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--no-first-run',
    '--disable-extensions',
  ];
  const opts = {
    headless: true,
    args,
  };
  const executablePath = String(
    env.PUPPETEER_EXECUTABLE_PATH || env.CHROME_PATH || ''
  ).trim();
  if (executablePath) {
    opts.executablePath = executablePath;
  }
  return opts;
}
