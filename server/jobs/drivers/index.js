export { ATS, DB_STATUS, SUBMIT_CODES, SUBMIT_STATUS, toDisplayStatus } from './statuses.js';
export { detectAts, detectAtsFromDom, detectAtsFromUrl } from './detect-ats.js';
export {
  buildGenericFieldSelectors,
  mapProfileToFormFields,
  resolveHeadless,
  verifySubmissionSuccess,
  captureFailureScreenshot,
} from './common.js';
export { runGreenhouseDriver } from './greenhouse.js';
export { runLeverDriver } from './lever.js';
export { runWorkdayDriver } from './workday.js';
export { runGenericDriver } from './generic.js';

import { ATS } from './statuses.js';
import { runGreenhouseDriver } from './greenhouse.js';
import { runLeverDriver } from './lever.js';
import { runWorkdayDriver } from './workday.js';
import { runGenericDriver } from './generic.js';

/**
 * @param {'workday'|'greenhouse'|'lever'|'generic'} ats
 */
export function getAtsDriver(ats) {
  switch (ats) {
    case ATS.WORKDAY:
      return runWorkdayDriver;
    case ATS.GREENHOUSE:
      return runGreenhouseDriver;
    case ATS.LEVER:
      return runLeverDriver;
    case ATS.GENERIC:
    default:
      return runGenericDriver;
  }
}
