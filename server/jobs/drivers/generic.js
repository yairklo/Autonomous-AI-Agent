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
 * Generic / direct HTML form fallback with strict confirmation checks.
 */
export async function runGenericDriver(ctx) {
  const { page, profile, coverLetter, cvPath, formUrl, jobId, onLog } = ctx;
  const fields = mapProfileToFormFields(profile, coverLetter);
  const ats = ATS.GENERIC;
  const filled = [];
  let step = 'load';

  log(onLog, `[${ats}] start ${formUrl}`);

  step = 'click_apply';
  await clickFirstVisible(page, APPLY_BUTTON_SELECTORS, { timeout: 5000 });
  await page.waitForTimeout(500);

  const auth = await detectAuthOrCaptchaBlock(page);
  if (auth.blocked) {
    return buildBlockedResult({
      page,
      jobId,
      ats,
      step: `auth_block:${auth.kind}`,
      code: SUBMIT_CODES.HUMAN_INTERVENTION_REQUIRED,
      message: `Generic form blocked: ${auth.detail}`,
      formUrl,
      filled,
    });
  }

  step = 'fill_fields';
  filled.push(
    ...(await fillMappedFields(page, buildGenericFieldSelectors(fields), {
      onLog,
    }))
  );

  step = 'upload_cv';
  await uploadCv(page, cvPath, { onLog });

  step = 'checkboxes';
  await checkRequiredCheckboxes(page, { onLog });

  step = 'submit';
  const clicked = await clickFirstVisible(page, SUBMIT_BUTTON_SELECTORS, {
    timeout: 12000,
  });
  if (!clicked) {
    return buildBlockedResult({
      page,
      jobId,
      ats,
      step: 'submit_button_missing',
      code: SUBMIT_CODES.UNMAPPED_REQUIRED_FIELD,
      message: 'Generic form: no submit/apply button found',
      formUrl,
      filled,
    });
  }

  await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1000);

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
        code: SUBMIT_CODES.HUMAN_INTERVENTION_REQUIRED,
        message: `Generic form post-submit block: ${postAuth.detail}`,
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
        'Generic form: click happened but confirmation was not verified — not marking Submitted',
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
