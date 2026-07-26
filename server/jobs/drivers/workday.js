import {
  APPLY_BUTTON_SELECTORS,
  buildBlockedResult,
  buildFailedResult,
  buildSuccessResult,
  captureFailureScreenshot,
  checkRequiredCheckboxes,
  clickFirstVisible,
  detectAuthOrCaptchaBlock,
  fillMappedFields,
  log,
  mapProfileToFormFields,
  uploadCv,
  verifySubmissionSuccess,
} from './common.js';
import { ATS, SUBMIT_CODES } from './statuses.js';

const WORKDAY_NEXT = [
  '[data-automation-id="bottom-navigation-next-button"]',
  '[data-automation-id="pageFooterNextButton"]',
  'button[data-automation-id="bottom-navigation-next-button"]',
  'button:has-text("Save and Continue")',
  'button:has-text("Continue")',
  'button:has-text("Next")',
  'button:has-text("Submit")',
].join(', ');

const WORKDAY_APPLY = [
  'a[data-automation-id="adventureButton"]',
  'button[data-automation-id="adventureButton"]',
  'a[data-automation-id="jobPostingApplyButton"]',
  'button[data-automation-id="jobPostingApplyButton"]',
  'button:has-text("Apply Manually")',
  'a:has-text("Apply Manually")',
  'button:has-text("Apply")',
  'a:has-text("Apply")',
  APPLY_BUTTON_SELECTORS,
].join(', ');

/**
 * Workday multi-step wizard driver.
 * Never reports Submitted unless confirmation is verified.
 * Auth / CAPTCHA / 2FA → HUMAN_INTERVENTION_REQUIRED.
 */
export async function runWorkdayDriver(ctx) {
  const { page, profile, coverLetter, cvPath, formUrl, jobId, onLog } = ctx;
  const fields = mapProfileToFormFields(profile, coverLetter);
  const ats = ATS.WORKDAY;
  const filled = [];
  let step = 'load_job';

  log(onLog, `[${ats}] start ${formUrl}`);

  // Workday is a heavy SPA — wait for shell / apply controls before acting
  step = 'wait_for_shell';
  await page
    .waitForLoadState('networkidle', { timeout: 25000 })
    .catch(() => {});
  await page
    .waitForSelector(
      [
        '[data-automation-id="jobPostingPage"]',
        '[data-automation-id="adventureButton"]',
        '[data-automation-id="jobPostingHeader"]',
        'button:has-text("Apply")',
        'a:has-text("Apply")',
        'text=/Apply/i',
      ].join(', '),
      { timeout: 25000 }
    )
    .catch(() => {});

  const bodyPreview = await page.evaluate(() =>
    (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 200)
  );
  if (!bodyPreview || bodyPreview.length < 20) {
    log(onLog, `[${ats}] empty/blocked page body — human intervention`);
    return buildBlockedResult({
      page,
      jobId,
      ats,
      step: 'page_empty_or_blocked',
      code: SUBMIT_CODES.HUMAN_INTERVENTION_REQUIRED,
      message:
        'Workday page did not render application UI (empty/blocked — try HEADLESS_BROWSER=false)',
      formUrl,
      filled,
    });
  }

  // 1) Initial Apply / Apply Manually
  step = 'click_apply';
  const applied = await clickFirstVisible(page, WORKDAY_APPLY, { timeout: 15000 });
  log(onLog, `[${ats}] apply click=${applied}`);
  if (!applied) {
    // Try role-based fallback
    const roleApply = page.getByRole('button', { name: /apply/i });
    const roleLink = page.getByRole('link', { name: /apply/i });
    let clicked = false;
    if ((await roleApply.count()) > 0) {
      clicked = await roleApply
        .first()
        .click({ timeout: 8000 })
        .then(() => true)
        .catch(() => false);
    }
    if (!clicked && (await roleLink.count()) > 0) {
      clicked = await roleLink
        .first()
        .click({ timeout: 8000 })
        .then(() => true)
        .catch(() => false);
    }
    log(onLog, `[${ats}] role-based apply click=${clicked}`);
    if (!clicked) {
      return buildBlockedResult({
        page,
        jobId,
        ats,
        step: 'apply_button_missing',
        code: SUBMIT_CODES.HUMAN_INTERVENTION_REQUIRED,
        message:
          'Workday: could not find Apply / Apply Manually — complete manually',
        formUrl,
        filled,
      });
    }
  }
  await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1200);

  // Prefer "Apply Manually" over "Autofill with Resume" / LinkedIn
  step = 'choose_manual_apply';
  const manual = await clickFirstVisible(
    page,
    [
      'a:has-text("Apply Manually")',
      'button:has-text("Apply Manually")',
      '[data-automation-id="applyManually"]',
      'button:has-text("Start")',
    ].join(', '),
    { timeout: 8000 }
  );
  if (manual) {
    await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1000);
  }

  // Wait for either application fields or an auth wall after Apply
  step = 'wait_after_apply';
  await page
    .waitForLoadState('networkidle', { timeout: 20000 })
    .catch(() => {});
  await page
    .waitForSelector(
      [
        'input[type="email"]',
        'input[type="password"]',
        'input[data-automation-id="email"]',
        'input[data-automation-id="legalNameSection_firstName"]',
        '[data-automation-id="createAccountButton"]',
        '[data-automation-id="signInButton"]',
        '[data-automation-id="bottom-navigation-next-button"]',
        'input[type="file"]',
        'text=/Create Account/i',
        'text=/Sign In/i',
      ].join(', '),
      { timeout: 20000 }
    )
    .catch(() => {});

  // 2) Auth / guest / CAPTCHA gate
  step = 'auth_or_guest';
  const auth = await detectAuthOrCaptchaBlock(page);
  if (auth.blocked) {
    log(onLog, `[${ats}] HUMAN_INTERVENTION_REQUIRED at ${step}: ${auth.detail}`);
    return buildBlockedResult({
      page,
      jobId,
      ats,
      step: `auth_block:${auth.kind}`,
      code: SUBMIT_CODES.HUMAN_INTERVENTION_REQUIRED,
      message: `Workday requires human intervention (${auth.kind}): ${auth.detail}`,
      formUrl,
      filled,
    });
  }

  // Empty apply shell with Sign In in chrome → account required
  const onApplyPath = /\/apply/i.test(page.url());
  const hasFormFields = await page
    .locator(
      'input[type="email"], input[type="text"], input[type="file"], textarea, select'
    )
    .count()
    .catch(() => 0);
  const signInLink = page.locator(
    'a:has-text("Sign In"), button:has-text("Sign In"), [data-automation-id="signInLink"]'
  );
  if (
    onApplyPath &&
    hasFormFields === 0 &&
    (await signInLink.count()) > 0
  ) {
    return buildBlockedResult({
      page,
      jobId,
      ats,
      step: 'auth_block:sign_in_required',
      code: SUBMIT_CODES.HUMAN_INTERVENTION_REQUIRED,
      message:
        'Workday apply shell loaded without form fields — Sign In / account required',
      formUrl,
      filled,
    });
  }

  // Guest / create account email sometimes shown without password yet
  await fillWorkdayIdentity(page, fields, filled, onLog);

  // 3) Wizard steps: My Information → Experience → Application Questions → Review
  const maxSteps = 12;
  for (let i = 0; i < maxSteps; i++) {
    step = `wizard_step_${i + 1}`;
    log(onLog, `[${ats}] ${step} url=${page.url()}`);

    const midAuth = await detectAuthOrCaptchaBlock(page);
    if (midAuth.blocked) {
      return buildBlockedResult({
        page,
        jobId,
        ats,
        step: `${step}:auth_block:${midAuth.kind}`,
        code: SUBMIT_CODES.HUMAN_INTERVENTION_REQUIRED,
        message: `Workday blocked at ${step}: ${midAuth.detail}`,
        formUrl,
        filled,
      });
    }

    const confirmation = await verifySubmissionSuccess(page);
    if (confirmation.verified) {
      return buildSuccessResult({
        ats,
        formUrl,
        finalUrl: page.url(),
        filled,
        cvPath,
        verification: confirmation,
      });
    }

    await fillWorkdayIdentity(page, fields, filled, onLog);
    await fillWorkdayExperienceHints(page, fields, filled, onLog);
    await uploadCv(page, cvPath, { onLog }).catch(() => false);
    await checkRequiredCheckboxes(page, { onLog });

    // Unmapped required fields (aria-invalid / required empty)
    const stuck = await findUnmappedRequired(page);
    if (stuck) {
      return buildBlockedResult({
        page,
        jobId,
        ats,
        step: `${step}:unmapped_required:${stuck}`,
        code: SUBMIT_CODES.UNMAPPED_REQUIRED_FIELD,
        message: `Workday unmapped required field: ${stuck}`,
        formUrl,
        filled,
      });
    }

    const advanced = await clickFirstVisible(page, WORKDAY_NEXT, { timeout: 10000 });
    if (!advanced) {
      // Maybe we're on final submit without a recognizable next
      const submitOnly = await clickFirstVisible(
        page,
        'button:has-text("Submit"), button[data-automation-id="bottom-navigation-next-button"]',
        { timeout: 5000 }
      );
      if (!submitOnly) {
        return buildBlockedResult({
          page,
          jobId,
          ats,
          step: `${step}:no_next`,
          code: SUBMIT_CODES.HUMAN_INTERVENTION_REQUIRED,
          message:
            'Workday wizard stuck: no Next/Continue/Submit control found',
          formUrl,
          filled,
        });
      }
    }

    await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1200);

    // Error banners after next
    const errorBanner = page.locator(
      '[data-automation-id="errorMessage"], [data-automation-id="formField-error"], .error, [aria-live="assertive"]'
    );
    if ((await errorBanner.count()) > 0) {
      const errText = (
        await errorBanner.first().innerText().catch(() => '')
      ).slice(0, 200);
      if (/required|invalid|error|complete|missing/i.test(errText)) {
        return buildBlockedResult({
          page,
          jobId,
          ats,
          step: `${step}:validation_error`,
          code: SUBMIT_CODES.UNMAPPED_REQUIRED_FIELD,
          message: `Workday validation error: ${errText || 'required fields'}`,
          formUrl,
          filled,
        });
      }
    }
  }

  step = 'final_verify';
  const verification = await verifySubmissionSuccess(page);
  if (verification.verified) {
    return buildSuccessResult({
      ats,
      formUrl,
      finalUrl: page.url(),
      filled,
      cvPath,
      verification,
    });
  }

  const screenshotPath = await captureFailureScreenshot(page, jobId);
  return buildFailedResult({
    ats,
    step,
    code: SUBMIT_CODES.CONFIRMATION_NOT_VERIFIED,
    message:
      'Workday: completed wizard attempts but no confirmation screen verified — not marking Submitted',
    formUrl,
    finalUrl: page.url(),
    screenshotPath,
    filled,
  });
}

async function fillWorkdayIdentity(page, fields, filled, onLog) {
  const map = {
    'input[data-automation-id="legalNameSection_firstName"], input[name*="firstName" i], input[id*="firstName" i], input[autocomplete="given-name"]':
      fields.firstName,
    'input[data-automation-id="legalNameSection_lastName"], input[name*="lastName" i], input[id*="lastName" i], input[autocomplete="family-name"]':
      fields.lastName,
    'input[data-automation-id="email"], input[type="email"], input[name*="email" i]':
      fields.email,
    'input[data-automation-id="phone-number"], input[data-automation-id="phone"], input[type="tel"], input[name*="phone" i]':
      fields.phone,
    'input[data-automation-id="linkedinQuestion"], input[name*="linkedin" i]':
      fields.linkedin,
    'textarea[data-automation-id="coverLetter"], textarea[name*="cover" i]':
      fields.coverLetter,
  };
  const got = await fillMappedFields(page, map, { onLog });
  filled.push(...got);
}

async function fillWorkdayExperienceHints(page, fields, filled, onLog) {
  // Light-touch: only fill clearly labeled LinkedIn / website / source fields
  const map = {
    'input[data-automation-id="website"], input[name*="website" i]':
      fields.github || fields.linkedin,
    'input[data-automation-id="linkedin"], input[aria-label*="LinkedIn" i]':
      fields.linkedin,
  };
  const got = await fillMappedFields(page, map, { onLog });
  filled.push(...got);
}

async function findUnmappedRequired(page) {
  try {
    return await page.evaluate(() => {
      const inputs = Array.from(
        document.querySelectorAll('input, select, textarea')
      );
      for (const el of inputs) {
        const style = window.getComputedStyle(el);
        if (
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          el.offsetParent === null
        ) {
          continue;
        }
        const required =
          el.required || el.getAttribute('aria-required') === 'true';
        if (!required) continue;
        const type = (el.getAttribute('type') || '').toLowerCase();
        if (
          [
            'hidden',
            'submit',
            'button',
            'checkbox',
            'radio',
            'file',
            'password',
          ].includes(type)
        ) {
          continue;
        }
        const val = (el.value || '').trim();
        if (!val) {
          return (
            el.getAttribute('data-automation-id') ||
            el.getAttribute('name') ||
            el.getAttribute('id') ||
            el.getAttribute('aria-label') ||
            'unknown-required'
          );
        }
      }
      return null;
    });
  } catch {
    return null;
  }
}
