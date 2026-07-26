import {
  APPLY_BUTTON_SELECTORS,
  SUBMIT_BUTTON_SELECTORS,
  buildGenericFieldSelectors,
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

/**
 * Greenhouse boards (boards.greenhouse.io / grnh.se) — single/multi-page forms.
 */
export async function runGreenhouseDriver(ctx) {
  const { page, profile, coverLetter, cvPath, formUrl, jobId, onLog } = ctx;
  const fields = mapProfileToFormFields(profile, coverLetter);
  const ats = ATS.GREENHOUSE;
  let step = 'load';
  const filled = [];

  log(onLog, `[${ats}] start ${formUrl}`);

  step = 'click_apply';
  await clickFirstVisible(page, APPLY_BUTTON_SELECTORS, { timeout: 5000 });
  await page.waitForTimeout(800);

  const auth = await detectAuthOrCaptchaBlock(page);
  if (auth.blocked) {
    return buildBlockedResult({
      page,
      jobId,
      ats,
      step: `auth_block:${auth.kind}`,
      code: SUBMIT_CODES.CAPTCHA_OR_AUTH_BLOCK,
      message: `Greenhouse blocked: ${auth.detail}`,
      formUrl,
      filled,
    });
  }

  step = 'fill_fields';
  const map = {
    ...buildGenericFieldSelectors(fields),
    'input[id="first_name"], input[name="job_application[first_name]"]':
      fields.firstName,
    'input[id="last_name"], input[name="job_application[last_name]"]':
      fields.lastName,
    'input[id="email"], input[name="job_application[email]"]': fields.email,
    'input[id="phone"], input[name="job_application[phone]"]': fields.phone,
    'input[autocomplete="custom-question-linkedin-profile"], input[name*="linkedin" i]':
      fields.linkedin,
    'textarea[id="cover_letter_text"], textarea[name*="cover_letter" i]':
      fields.coverLetter,
  };
  filled.push(...(await fillMappedFields(page, map, { onLog })));

  step = 'upload_cv';
  await uploadCv(page, cvPath, { onLog });

  step = 'checkboxes';
  await checkRequiredCheckboxes(page, { onLog });

  for (let i = 0; i < 4; i++) {
    const next = page.locator(
      'button:has-text("Next"), button:has-text("Continue"), a:has-text("Next")'
    );
    if ((await next.count()) === 0) break;
    const vis = await next.first().isVisible().catch(() => false);
    if (!vis) break;
    step = `multi_page_next_${i + 1}`;
    await next.first().click({ timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(1000);
    const midAuth = await detectAuthOrCaptchaBlock(page);
    if (midAuth.blocked) {
      return buildBlockedResult({
        page,
        jobId,
        ats,
        step: `auth_block:${midAuth.kind}`,
        code: SUBMIT_CODES.CAPTCHA_OR_AUTH_BLOCK,
        message: `Greenhouse blocked mid-flow: ${midAuth.detail}`,
        formUrl,
        filled,
      });
    }
    filled.push(...(await fillMappedFields(page, map, { onLog })));
    await uploadCv(page, cvPath, { onLog }).catch(() => false);
    await checkRequiredCheckboxes(page, { onLog });
  }

  step = 'submit';
  const clicked = await clickFirstVisible(
    page,
    `${SUBMIT_BUTTON_SELECTORS}, #submit_app, input#submit_app`,
    { timeout: 12000 }
  );
  if (!clicked) {
    return buildBlockedResult({
      page,
      jobId,
      ats,
      step: 'submit_button_missing',
      code: SUBMIT_CODES.UNMAPPED_REQUIRED_FIELD,
      message: 'Greenhouse: could not find a submit button',
      formUrl,
      filled,
    });
  }

  await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1500);

  step = 'verify';
  const verification = await verifySubmissionSuccess(page);
  if (!verification.verified) {
    const postAuth = await detectAuthOrCaptchaBlock(page);
    if (postAuth.blocked) {
      return buildBlockedResult({
        page,
        jobId,
        ats,
        step: `post_submit_auth:${postAuth.kind}`,
        code: SUBMIT_CODES.CAPTCHA_OR_AUTH_BLOCK,
        message: `Greenhouse post-submit block: ${postAuth.detail}`,
        formUrl,
        filled,
      });
    }
    const screenshotPath = await captureFailureScreenshot(page, jobId);
    return buildFailedResult({
      ats,
      step: 'confirmation_missing',
      code: SUBMIT_CODES.CONFIRMATION_NOT_VERIFIED,
      message:
        'Greenhouse: submit clicked but confirmation text/URL was not verified',
      formUrl,
      finalUrl: page.url(),
      screenshotPath,
      filled,
    });
  }

  return buildSuccessResult({
    ats,
    formUrl,
    finalUrl: page.url(),
    filled,
    cvPath,
    verification,
  });
}
