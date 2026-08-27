import fs from 'node:fs';
import path from 'node:path';

import {
  ATS,
  SUBMIT_CODES,
  SUBMIT_STATUS,
  detectAts,
  detectAtsFromUrl,
  getAtsDriver,
  mapProfileToFormFields,
  resolveHeadless,
  buildGenericFieldSelectors,
} from './drivers/index.js';

function resolvePlaywrightExecutable() {
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/usr/local/bin/wa-chrome',
  ];
  for (const raw of candidates) {
    const p = String(raw || '').trim();
    if (p && fs.existsSync(p)) return p;
  }
  return '';
}

/**
 * Playwright form submitter with ATS-aware drivers (Workday / Greenhouse / Lever / generic).
 * Never sends WhatsApp DMs or group replies.
 * Never reports status Submitted unless confirmation DOM/URL is verified.
 *
 * @param {object} opts
 * @param {string} opts.formUrl
 * @param {object} opts.profile - name, email, phone, linkedin, github
 * @param {string} opts.cvPath
 * @param {string} opts.coverLetter
 * @param {boolean} [opts.approved] - MUST be true
 * @param {boolean} [opts.dryRun]
 * @param {string} [opts.jobId] - used for failed-<jobId>.png screenshots
 * @param {(msg: string) => void} [opts.onLog]
 * @param {() => Promise<{ newPage: Function, close?: Function }>} [opts.browserFactory]
 */
export async function submitJobFormWithPlaywright({
  formUrl,
  profile,
  cvPath,
  coverLetter,
  approved = false,
  dryRun = false,
  jobId = null,
  onLog,
  browserFactory,
} = {}) {
  if (!approved) {
    const err = new Error(
      'Refusing Playwright submit: Telegram Approve is required (never submit without approval)'
    );
    err.code = SUBMIT_CODES.SUBMIT_NOT_APPROVED;
    throw err;
  }

  const url = String(formUrl || '').trim();
  if (!url || !/^https?:\/\//i.test(url)) {
    const err = new Error(
      'Playwright submit requires an http(s) form URL (forms only; no WhatsApp DM/reply)'
    );
    err.code = SUBMIT_CODES.SUBMIT_NO_FORM_URL;
    throw err;
  }

  const cv = path.resolve(String(cvPath || '').trim());
  if (!cv || !fs.existsSync(cv) || !fs.statSync(cv).isFile()) {
    const err = new Error(`CV file not found for form upload: ${cv}`);
    err.code = SUBMIT_CODES.CV_NOT_FOUND;
    throw err;
  }

  const fields = mapProfileToFormFields(profile, coverLetter);
  const atsHint = detectAtsFromUrl(url);

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      confirmationVerified: false,
      status: 'dry_run',
      ats: atsHint,
      formUrl: url,
      filled: Object.keys(buildGenericFieldSelectors(fields)),
      cvPath: cv,
      channel: 'playwright_forms_only',
      whatsappSend: false,
    };
  }

  const headless = resolveHeadless();
  onLog?.(
    `[playwright-submitter] ATS hint=${atsHint} headless=${headless} jobId=${jobId || 'n/a'}`
  );

  const factory =
    browserFactory ||
    (async () => {
      let playwright;
      try {
        playwright = await import('playwright');
      } catch (cause) {
        const err = new Error(
          'playwright is not installed. Run: npm install playwright && npx playwright install chromium'
        );
        err.code = SUBMIT_CODES.PLAYWRIGHT_MISSING;
        err.cause = cause;
        throw err;
      }
      // HEADLESS_BROWSER=true|false (default true). In Docker/Coolify set HEADLESS_BROWSER=true.
      // Pin npm playwright to the Docker image (1.50.1 / Chromium ~133). A newer
      // playwright package looks for chromium_headless_shell-NNNN that is not in
      // this image; bumping the image to 1.62 breaks whatsapp-web.js getChats ("r").
      const launchArgs = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
      ];
      if (headless) {
        launchArgs.push('--disable-blink-features=AutomationControlled');
      }
      const executablePath = resolvePlaywrightExecutable();
      if (executablePath) {
        onLog?.(`[playwright-submitter] chromium executable=${executablePath}`);
      }
      const browser = await playwright.chromium.launch({
        headless,
        args: launchArgs,
        ...(executablePath ? { executablePath } : {}),
      });
      const context = await browser.newContext({
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        locale: 'en-US',
        viewport: { width: 1280, height: 900 },
      });
      return {
        newPage: () => context.newPage(),
        close: async () => {
          await context.close().catch(() => {});
          await browser.close();
        },
      };
    });

  const browser = await factory();
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(30000);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    const ats = await detectAts(url, page);
    onLog?.(`[playwright-submitter] detected ATS=${ats}`);

    const driver = getAtsDriver(ats);
    const result = await driver({
      page,
      profile,
      coverLetter,
      cvPath: cv,
      formUrl: url,
      jobId,
      onLog,
    });

    // Hard rule: never claim Submitted without verification flag
    if (result?.status === SUBMIT_STATUS.SUBMITTED && !result.confirmationVerified) {
      onLog?.(
        '[playwright-submitter] refusing unverified Submitted — downgrading to failed'
      );
      return {
        ...result,
        ok: false,
        status: SUBMIT_STATUS.SUBMISSION_FAILED,
        code: SUBMIT_CODES.CONFIRMATION_NOT_VERIFIED,
        message: 'Confirmation not verified; refusing to mark Submitted',
      };
    }

    onLog?.(
      `[playwright-submitter] done status=${result.status} code=${result.code || 'ok'} step=${result.step}`
    );
    return result;
  } catch (err) {
    onLog?.(`[playwright-submitter] error: ${err.message}`);
    throw err;
  } finally {
    await browser.close?.();
  }
}

export {
  mapProfileToFormFields,
  detectAtsFromUrl,
  resolveHeadless,
  ATS,
  SUBMIT_STATUS,
  SUBMIT_CODES,
};

/** @deprecated Prefer buildGenericFieldSelectors via drivers; kept for unit tests. */
export function mapProfileToFormFieldsLegacy(profile = {}, coverLetter = '') {
  const fields = mapProfileToFormFields(profile, coverLetter);
  return buildGenericFieldSelectors(fields);
}
