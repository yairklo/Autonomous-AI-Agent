/**
 * Strict submission outcomes — never report Submitted without confirmation.
 */

export const SUBMIT_STATUS = {
  SUBMITTED: 'Submitted',
  REQUIRES_MANUAL_ACTION: 'Requires Manual Action',
  SUBMISSION_FAILED: 'Submission Failed',
};

/** Normalized DB/tracker status keys (snake for storage, display via SUBMIT_STATUS). */
export const DB_STATUS = {
  SUBMITTED: 'submitted',
  REQUIRES_MANUAL_ACTION: 'requires_manual_action',
  SUBMIT_FAILED: 'submit_failed',
};

export const SUBMIT_CODES = {
  HUMAN_INTERVENTION_REQUIRED: 'HUMAN_INTERVENTION_REQUIRED',
  CONFIRMATION_NOT_VERIFIED: 'CONFIRMATION_NOT_VERIFIED',
  CAPTCHA_OR_AUTH_BLOCK: 'CAPTCHA_OR_AUTH_BLOCK',
  UNMAPPED_REQUIRED_FIELD: 'UNMAPPED_REQUIRED_FIELD',
  ATS_NAVIGATION_FAILED: 'ATS_NAVIGATION_FAILED',
  SUBMIT_NOT_APPROVED: 'SUBMIT_NOT_APPROVED',
  SUBMIT_NO_FORM_URL: 'SUBMIT_NO_FORM_URL',
  CV_NOT_FOUND: 'CV_NOT_FOUND',
  PLAYWRIGHT_MISSING: 'PLAYWRIGHT_MISSING',
};

export const ATS = {
  WORKDAY: 'workday',
  GREENHOUSE: 'greenhouse',
  LEVER: 'lever',
  GENERIC: 'generic',
};

export function toDisplayStatus(dbOrDisplay) {
  const s = String(dbOrDisplay || '');
  if (s === DB_STATUS.SUBMITTED || s === SUBMIT_STATUS.SUBMITTED) {
    return SUBMIT_STATUS.SUBMITTED;
  }
  if (
    s === DB_STATUS.REQUIRES_MANUAL_ACTION ||
    s === SUBMIT_STATUS.REQUIRES_MANUAL_ACTION
  ) {
    return SUBMIT_STATUS.REQUIRES_MANUAL_ACTION;
  }
  if (
    s === DB_STATUS.SUBMIT_FAILED ||
    s === SUBMIT_STATUS.SUBMISSION_FAILED ||
    s === 'submit_failed'
  ) {
    return SUBMIT_STATUS.SUBMISSION_FAILED;
  }
  return s || SUBMIT_STATUS.SUBMISSION_FAILED;
}
