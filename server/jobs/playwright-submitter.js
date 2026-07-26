import fs from 'node:fs';
import path from 'node:path';

/**
 * Playwright form submitter for external apply URLs only.
 * Never sends WhatsApp DMs or group replies.
 *
 * @param {object} opts
 * @param {string} opts.formUrl
 * @param {object} opts.profile - name, email, phone, linkedin, github
 * @param {string} opts.cvPath
 * @param {string} opts.coverLetter
 * @param {boolean} [opts.approved] - MUST be true
 * @param {boolean} [opts.dryRun]
 * @param {() => Promise<{ newPage: Function, close?: Function }>} [opts.browserFactory]
 */
export async function submitJobFormWithPlaywright({
  formUrl,
  profile,
  cvPath,
  coverLetter,
  approved = false,
  dryRun = false,
  browserFactory,
} = {}) {
  if (!approved) {
    const err = new Error(
      'Refusing Playwright submit: Telegram Approve is required (never submit without approval)'
    );
    err.code = 'SUBMIT_NOT_APPROVED';
    throw err;
  }

  const url = String(formUrl || '').trim();
  if (!url || !/^https?:\/\//i.test(url)) {
    const err = new Error(
      'Playwright submit requires an http(s) form URL (forms only; no WhatsApp DM/reply)'
    );
    err.code = 'SUBMIT_NO_FORM_URL';
    throw err;
  }

  const cv = path.resolve(String(cvPath || '').trim());
  if (!cv || !fs.existsSync(cv) || !fs.statSync(cv).isFile()) {
    const err = new Error(`CV file not found for form upload: ${cv}`);
    err.code = 'CV_NOT_FOUND';
    throw err;
  }

  const fields = mapProfileToFormFields(profile, coverLetter);

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      formUrl: url,
      filled: Object.keys(fields),
      cvPath: cv,
      channel: 'playwright_forms_only',
      whatsappSend: false,
    };
  }

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
        err.code = 'PLAYWRIGHT_MISSING';
        err.cause = cause;
        throw err;
      }
      const browser = await playwright.chromium.launch({ headless: true });
      return {
        newPage: () => browser.newPage(),
        close: () => browser.close(),
      };
    });

  const browser = await factory();
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    for (const [selector, value] of Object.entries(fields)) {
      if (value == null || value === '') continue;
      const loc = page.locator(selector).first();
      if ((await loc.count()) === 0) continue;
      try {
        await loc.fill(String(value));
      } catch {
        /* field may be non-text */
      }
    }

    const fileInput = page.locator('input[type="file"]').first();
    if ((await fileInput.count()) > 0) {
      await fileInput.setInputFiles(cv);
    }

    const submit = page
      .locator(
        'button[type="submit"], input[type="submit"], button:has-text("Submit"), button:has-text("Apply"), button:has-text("שלח"), button:has-text("הגש")'
      )
      .first();
    if ((await submit.count()) > 0) {
      await submit.click({ timeout: 15000 }).catch(() => {});
    }

    return {
      ok: true,
      dryRun: false,
      formUrl: url,
      filled: Object.keys(fields),
      cvPath: cv,
      channel: 'playwright_forms_only',
      whatsappSend: false,
      finalUrl: page.url(),
    };
  } finally {
    await browser.close?.();
  }
}

export function mapProfileToFormFields(profile = {}, coverLetter = '') {
  const name = profile.name || '';
  const email = profile.email || '';
  const phone = profile.phone || '';
  const linkedin = profile.linkedin || '';
  const github = profile.github || '';
  return {
    'input[name*="name" i], input[id*="name" i], input[autocomplete="name"]': name,
    'input[type="email"], input[name*="email" i], input[id*="email" i]': email,
    'input[type="tel"], input[name*="phone" i], input[id*="phone" i]': phone,
    'input[name*="linkedin" i], input[id*="linkedin" i]': linkedin,
    'input[name*="github" i], input[id*="github" i]': github,
    'textarea[name*="cover" i], textarea[name*="message" i], textarea[name*="letter" i], textarea':
      coverLetter,
  };
}
