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
 * Lever (jobs.lever.co) apply forms.
 */
export async function runLeverDriver(ctx) {
  const { page, profile, coverLetter, cvPath, formUrl, jobId, onLog } = ctx;
  const fields = mapProfileToFormFields(profile, coverLetter);
  const ats = ATS.LEVER;
  let step = 'load';
  const filled = [];

  log(onLog, `[${ats}] start ${formUrl}`);

  // Job posting → Apply
  step = 'click_apply';
  const applyClicked = await clickFirstVisible(
    page,
    `${APPLY_BUTTON_SELECTORS}, a.postings-btn, .postings-btn`,
    { timeout: 8000 }
  );
  if (applyClicked) {
    await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(800);
  }

  const auth = await detectAuthOrCaptchaBlock(page);
  if (auth.blocked) {
    return buildBlockedResult({
      page,
      jobId,
      ats,
      step: `auth_block:${auth.kind}`,
      code: SUBMIT_CODES.CAPTCHA_OR_AUTH_BLOCK,
      message: `Lever blocked: ${auth.detail}`,
      formUrl,
      filled,
    });
  }

  step = 'fill_fields';
  const map = {
    ...buildGenericFieldSelectors(fields),
    'input[name="name"]': fields.name,
    'input[name="email"]': fields.email,
    'input[name="phone"]': fields.phone,
    'input[name="org"]': '',
    'input[name="urls[LinkedIn]"], input[name*="LinkedIn" i]': fields.linkedin,
    'input[name="urls[GitHub]"], input[name*="GitHub" i]': fields.github,
    'textarea[name="comments"], textarea[name="additionalInformation"]':
      fields.coverLetter,
  };
  filled.push(...(await fillMappedFields(page, map, { onLog })));

  step = 'upload_cv';
  await uploadCv(page, cvPath, { onLog });

  step = 'checkboxes';
  await checkRequiredCheckboxes(page, { onLog });

  step = 'submit';
  const clicked = await clickFirstVisible(
    page,
    `${SUBMIT_BUTTON_SELECTORS}, button[data-qa="btn-submit"], .template-btn-submit`,
    { timeout: 12000 }
  );
  if (!clicked) {
    return buildBlockedResult({
      page,
      jobId,
      ats,
      step: 'submit_button_missing',
      code: SUBMIT_CODES.UNMAPPED_REQUIRED_FIELD,
      message: 'Lever: could not find a submit button',
      formUrl,
      filled,
    });
  }

  await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1500);

  step = 'verify';
  const verification = await verifySubmissionSuccess(page);
  if (!verification.verified) {
    // Lever success often lands on /thanks or shows "Application submitted"
    const url = page.url();
    if (/\/thanks|confirmation/i.test(url)) {
      const soft = await verifySubmissionSuccess(page);
      if (soft.verified) {
        return buildSuccessResult({
          ats,
          formUrl,
          finalUrl: url,
          filled,
          cvPath,
          verification: soft,
        });
      }
    }
    const postAuth = await detectAuthOrCaptchaBlock(page);
    if (postAuth.blocked) {
      return buildBlockedResult({
        page,
        jobId,
        ats,
        step: `post_submit_auth:${postAuth.kind}`,
        code: SUBMIT_CODES.CAPTCHA_OR_AUTH_BLOCK,
        message: `Lever post-submit block: ${postAuth.detail}`,
        formUrl,
        filled,
      });
    }
    const screenshotPath = await captureFailureScreenshot(page, jobId);
    return buildFailedResult({
      ats,
      step: 'confirmation_missing',
      code: SUBMIT_CODES.CONFIRMATION_NOT_VERIFIED,
      message: 'Lever: submit clicked but confirmation was not verified',
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
