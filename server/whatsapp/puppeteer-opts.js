/**
 * Puppeteer launch options for whatsapp-web.js inside Docker/Coolify.
 *
 * Prefer image Chromium via PUPPETEER_EXECUTABLE_PATH=/usr/local/bin/wa-chrome
 * (Playwright v1.50.1-jammy). Optional override: /usr/bin/chromium
 */
export function buildWhatsappPuppeteerOpts(env = process.env) {
  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--no-first-run',
    '--no-zygote',
    '--disable-extensions',
  ];
  const opts = {
    headless: true,
    args,
  };
  if (String(env.WHATSAPP_CHROME_DUMPIO || '').trim() === '1') {
    opts.dumpio = true;
  }
  const executablePath = String(
    env.PUPPETEER_EXECUTABLE_PATH || env.CHROME_PATH || ''
  ).trim();
  if (executablePath) {
    opts.executablePath = executablePath;
  }
  return opts;
}
