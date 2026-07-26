import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUBMIT_CODES, SUBMIT_STATUS } from './statuses.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCREENSHOTS_DIR = path.join(ROOT, 'data', 'screenshots');

export const SUCCESS_PATTERNS = [
  /application\s+submitted/i,
  /thank\s+you\s+for\s+(your\s+)?(applying|application)/i,
  /thanks\s+for\s+(your\s+)?(applying|application)/i,
  /successfully\s+submitted/i,
  /we\s+(have\s+)?received\s+your\s+application/i,
  /application\s+(has\s+been\s+)?received/i,
  /you\s+applied/i,
  /הגשתך\s+התקבלה/,
  /תודה\s+על\s+הגשת/,
  /הבקשה\s+נשלחה/,
];

export const AUTH_BLOCK_PATTERNS = [
  /sign\s*in/i,
  /log\s*in/i,
  /create\s+(an\s+)?account/i,
  /verify\s+you\s+are\s+human/i,
  /captcha/i,
  /recaptcha/i,
  /two[- ]factor/i,
  /2fa/i,
  /one[- ]time\s+(pass|code)/i,
  /enter\s+(the\s+)?(code|otp)/i,
  /password/i,
  /authentication\s+required/i,
];

export const APPLY_BUTTON_SELECTORS = [
  'button:has-text("Apply Manually")',
  'a:has-text("Apply Manually")',
  'button:has-text("Apply Manual")',
  'a[data-automation-id="adventureButton"]',
  'button[data-automation-id="adventureButton"]',
  'a:has-text("Apply")',
  'button:has-text("Apply")',
  'a:has-text("הגש")',
  'button:has-text("הגש")',
  'a:has-text("שלח מועמדות")',
  'button:has-text("שלח מועמדות")',
].join(', ');

export const SUBMIT_BUTTON_SELECTORS = [
  'button[type="submit"]',
  'input[type="submit"]',
  'button:has-text("Submit Application")',
  'button:has-text("Submit")',
  'button:has-text("Send Application")',
  'button:has-text("Apply")',
  'button:has-text("שלח")',
  'button:has-text("הגש")',
  'a:has-text("Submit Application")',
  '[data-automation-id="bottom-navigation-next-button"]',
  '[data-automation-id="pageFooterNextButton"]',
].join(', ');

/**
 * @param {object} profile
 * @param {string} coverLetter
 */
export function mapProfileToFormFields(profile = {}, coverLetter = '') {
  const name = profile.name || '';
  const parts = String(name).trim().split(/\s+/);
  const firstName = profile.firstName || parts[0] || '';
  const lastName =
    profile.lastName || (parts.length > 1 ? parts.slice(1).join(' ') : '');
  const email = profile.email || '';
  const phone = profile.phone || '';
  const linkedin = profile.linkedin || '';
  const github = profile.github || '';
  return {
    name,
    firstName,
    lastName,
    email,
    phone,
    linkedin,
    github,
    coverLetter: coverLetter || '',
  };
}

/**
 * Generic CSS selector → value map for HTML forms.
 */
export function buildGenericFieldSelectors(fields) {
  return {
    'input[name*="first" i][name*="name" i], input[id*="first" i][id*="name" i], input[autocomplete="given-name"]':
      fields.firstName,
    'input[name*="last" i][name*="name" i], input[id*="last" i][id*="name" i], input[autocomplete="family-name"]':
      fields.lastName,
    'input[name*="name" i]:not([name*="first" i]):not([name*="last" i]):not([name*="company" i]):not([type="hidden"]), input[id*="name" i]:not([id*="first" i]):not([id*="last" i]), input[autocomplete="name"]':
      fields.name,
    'input[type="email"], input[name*="email" i], input[id*="email" i], input[autocomplete="email"]':
      fields.email,
    'input[type="tel"], input[name*="phone" i], input[id*="phone" i], input[autocomplete="tel"]':
      fields.phone,
    'input[name*="linkedin" i], input[id*="linkedin" i]': fields.linkedin,
    'input[name*="github" i], input[id*="github" i], input[name*="portfolio" i]':
      fields.github,
    'textarea[name*="cover" i], textarea[name*="message" i], textarea[name*="letter" i], textarea[name*="additional" i], textarea':
      fields.coverLetter,
  };
}

export function log(onLog, msg) {
  const line = `[playwright-submitter] ${msg}`;
  if (typeof onLog === 'function') onLog(line);
  else console.log(line);
}

/**
 * HEADLESS_BROWSER=true|false (default true for production).
 */
export function resolveHeadless(env = process.env) {
  const v = env.HEADLESS_BROWSER;
  if (v == null || String(v).trim() === '') return true;
  return !['0', 'false', 'no', 'off'].includes(String(v).trim().toLowerCase());
}

export function ensureScreenshotsDir() {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  return SCREENSHOTS_DIR;
}

/**
 * Save failure screenshot to data/screenshots/failed-<jobId>.png
 * @returns {Promise<string|null>} absolute path or null
 */
export async function captureFailureScreenshot(page, jobId) {
  try {
    ensureScreenshotsDir();
    const safeId = String(jobId || `unknown-${Date.now()}`).replace(
      /[^\w.-]+/g,
      '_'
    );
    const filePath = path.join(SCREENSHOTS_DIR, `failed-${safeId}.png`);
    await page.screenshot({ path: filePath, fullPage: true });
    return filePath;
  } catch (err) {
    console.error('[playwright-submitter] screenshot failed:', err.message);
    return null;
  }
}

/**
 * True only when confirmation copy / success URL is present.
 */
export async function verifySubmissionSuccess(page) {
  const url = page.url();
  if (/thank|success|confirmation|submitted|application[_-]?complete/i.test(url)) {
    const body = await safeBodyText(page);
    if (SUCCESS_PATTERNS.some((re) => re.test(body)) || /thank|success/i.test(url)) {
      // URL alone is weak — require body match when possible
      if (SUCCESS_PATTERNS.some((re) => re.test(body))) {
        return { verified: true, reason: 'success_text_and_url', url, matched: bodyMatch(body) };
      }
    }
  }

  const body = await safeBodyText(page);
  const matched = bodyMatch(body);
  if (matched) {
    return { verified: true, reason: 'success_text', url, matched };
  }

  // Explicit success nodes used by common ATS UIs
  const successLoc = page.locator(
    [
      'text=/Application Submitted/i',
      'text=/Thank you for applying/i',
      'text=/Thanks for applying/i',
      'text=/We (have )?received your application/i',
      '[data-automation-id="applicationSubmittedHeader"]',
      '[data-automation-id="successMessage"]',
      '.application-confirmation',
      '#application_confirmation',
    ].join(', ')
  );
  try {
    if ((await successLoc.count()) > 0 && (await successLoc.first().isVisible())) {
      const text = (await successLoc.first().innerText().catch(() => '')) || matched;
      return { verified: true, reason: 'success_dom', url, matched: text };
    }
  } catch {
    /* ignore */
  }

  return { verified: false, reason: 'no_confirmation', url, matched: null };
}

function bodyMatch(body) {
  for (const re of SUCCESS_PATTERNS) {
    const m = body.match(re);
    if (m) return m[0];
  }
  return null;
}

async function safeBodyText(page) {
  try {
    return await page.evaluate(() => document.body?.innerText || '');
  } catch {
    return '';
  }
}

/**
 * Detect login / CAPTCHA / 2FA walls that require a human.
 * Note: Workday often shows "Sign In" as an *option* beside Apply Manually —
 * that alone is not a block. Password / CAPTCHA / OTP are hard blocks.
 */
export async function detectAuthOrCaptchaBlock(page) {
  const url = page.url();
  const body = await safeBodyText(page);

  const captcha = page.locator(
    'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], .g-recaptcha, #captcha, [data-sitekey]'
  );
  if ((await captcha.count()) > 0) {
    const visible = await captcha.first().isVisible().catch(() => true);
    if (visible) {
      return { blocked: true, kind: 'captcha', detail: 'CAPTCHA widget present' };
    }
  }

  const passwordCandidates = page.locator(
    'input[type="password"], input[name*="password" i]'
  );
  const pwCount = await passwordCandidates.count();
  for (let i = 0; i < Math.min(pwCount, 5); i++) {
    if (await passwordCandidates.nth(i).isVisible().catch(() => false)) {
      return { blocked: true, kind: 'password', detail: 'Password field visible' };
    }
  }

  const otp = page.locator(
    [
      'text=/Enter (the )?code/i',
      'text=/one[- ]time/i',
      'text=/two[- ]factor/i',
      'text=/Verify you are human/i',
      'input[autocomplete="one-time-code"]',
    ].join(', ')
  );
  try {
    if ((await otp.count()) > 0 && (await otp.first().isVisible().catch(() => false))) {
      return { blocked: true, kind: '2fa_or_human', detail: 'OTP/2FA/human-verify UI' };
    }
  } catch {
    /* ignore */
  }

  // Hard auth URL (login host) with a sign-in form and no apply fields
  if (/login|signin|sign-in|\/auth\b|captcha|challenge/i.test(url)) {
    const hasApplyFields = await page
      .locator(
        'input[type="file"], input[data-automation-id*="Name" i], textarea, input[type="email"]'
      )
      .count()
      .catch(() => 0);
    if (hasApplyFields === 0 && AUTH_BLOCK_PATTERNS.some((re) => re.test(body))) {
      return { blocked: true, kind: 'url_auth', detail: url };
    }
  }

  // Dedicated sign-in panel with email+submit and no resume upload / legal name
  const signInOnly = page.locator(
    '[data-automation-id="signInSubmitButton"], button[data-automation-id="signInButton"]'
  );
  const applyManualStillThere = page.locator(
    'a:has-text("Apply Manually"), button:has-text("Apply Manually"), [data-automation-id="adventureButton"]'
  );
  try {
    if (
      (await signInOnly.count()) > 0 &&
      (await signInOnly.first().isVisible().catch(() => false)) &&
      (await applyManualStillThere.count()) === 0
    ) {
      return { blocked: true, kind: 'login_ui', detail: 'Sign-in submit without manual apply' };
    }
  } catch {
    /* ignore */
  }

  return { blocked: false };
}

/**
 * Fill the first matching locator for each selector→value entry.
 * @returns {Promise<string[]>} filled selector keys
 */
export async function fillMappedFields(page, selectorMap, { onLog } = {}) {
  const filled = [];
  for (const [selector, value] of Object.entries(selectorMap)) {
    if (value == null || value === '') continue;
    const loc = page.locator(selector).first();
    if ((await loc.count()) === 0) continue;
    try {
      if (!(await loc.isVisible().catch(() => false))) continue;
      await loc.fill(String(value), { timeout: 5000 });
      filled.push(selector);
      log(onLog, `filled field: ${selector.slice(0, 80)}`);
    } catch {
      try {
        await loc.click({ timeout: 2000 });
        await page.keyboard.type(String(value), { delay: 15 });
        filled.push(selector);
      } catch {
        /* skip unwritable */
      }
    }
  }
  return filled;
}

/**
 * Upload CV into the first visible file input.
 */
export async function uploadCv(page, cvPath, { onLog } = {}) {
  const fileInput = page.locator('input[type="file"]').first();
  if ((await fileInput.count()) === 0) {
    log(onLog, 'no file input found for CV upload');
    return false;
  }
  await fileInput.setInputFiles(cvPath);
  log(onLog, `uploaded CV: ${cvPath}`);
  return true;
}

/**
 * Check common consent / required checkboxes.
 */
export async function checkRequiredCheckboxes(page, { onLog } = {}) {
  const boxes = page.locator(
    'input[type="checkbox"]:not([disabled]), [role="checkbox"]:not([aria-disabled="true"])'
  );
  const count = await boxes.count();
  let checked = 0;
  for (let i = 0; i < Math.min(count, 20); i++) {
    const box = boxes.nth(i);
    try {
      if (!(await box.isVisible().catch(() => false))) continue;
      const already =
        (await box.isChecked?.().catch(() => false)) ||
        (await box.getAttribute('aria-checked')) === 'true';
      if (already) continue;
      // Prefer required / consent-ish boxes
      const name = (
        (await box.getAttribute('name')) ||
        (await box.getAttribute('id')) ||
        (await box.getAttribute('aria-label')) ||
        ''
      ).toLowerCase();
      const required =
        (await box.getAttribute('required')) != null ||
        (await box.getAttribute('aria-required')) === 'true' ||
        /consent|agree|term|privacy|policy|acknowledge|certify|eeo|veteran|disability/.test(
          name
        );
      if (!required && count > 3) continue;
      await box.check({ force: true }).catch(async () => {
        await box.click({ force: true });
      });
      checked += 1;
    } catch {
      /* skip */
    }
  }
  if (checked) log(onLog, `checked ${checked} checkbox(es)`);
  return checked;
}

/**
 * Click first visible matching control from a comma-separated selector list.
 */
export async function clickFirstVisible(page, selectors, { timeout = 8000 } = {}) {
  const loc = page.locator(selectors).first();
  if ((await loc.count()) === 0) return false;
  try {
    await loc.click({ timeout });
    return true;
  } catch {
    return false;
  }
}

/**
 * Build a structured human-intervention / failure result (never ok Submitted).
 */
export async function buildBlockedResult({
  page,
  jobId,
  ats,
  step,
  code = SUBMIT_CODES.HUMAN_INTERVENTION_REQUIRED,
  message,
  formUrl,
  filled = [],
}) {
  const screenshotPath = page
    ? await captureFailureScreenshot(page, jobId)
    : null;
  const finalUrl = page ? page.url() : formUrl;
  return {
    ok: false,
    confirmationVerified: false,
    status: SUBMIT_STATUS.REQUIRES_MANUAL_ACTION,
    code,
    ats,
    step,
    message:
      message ||
      `Human intervention required at step "${step}" (${ats})`,
    formUrl,
    finalUrl,
    screenshotPath,
    filled,
    channel: 'playwright_forms_only',
    whatsappSend: false,
    manualUrl: finalUrl || formUrl,
  };
}

export function buildFailedResult({
  ats,
  step,
  code = SUBMIT_CODES.CONFIRMATION_NOT_VERIFIED,
  message,
  formUrl,
  finalUrl,
  screenshotPath = null,
  filled = [],
}) {
  return {
    ok: false,
    confirmationVerified: false,
    status: SUBMIT_STATUS.SUBMISSION_FAILED,
    code,
    ats,
    step,
    message: message || `Submission failed at step "${step}"`,
    formUrl,
    finalUrl: finalUrl || formUrl,
    screenshotPath,
    filled,
    channel: 'playwright_forms_only',
    whatsappSend: false,
    manualUrl: finalUrl || formUrl,
  };
}

export function buildSuccessResult({
  ats,
  formUrl,
  finalUrl,
  filled = [],
  cvPath,
  verification,
}) {
  return {
    ok: true,
    confirmationVerified: true,
    status: SUBMIT_STATUS.SUBMITTED,
    ats,
    step: 'confirmed',
    message: `Application confirmed (${verification?.matched || verification?.reason || 'success'})`,
    formUrl,
    finalUrl,
    filled,
    cvPath,
    channel: 'playwright_forms_only',
    whatsappSend: false,
    verification,
  };
}

export { SCREENSHOTS_DIR, ROOT };
