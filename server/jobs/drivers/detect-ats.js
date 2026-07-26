import { ATS } from './statuses.js';

/**
 * Detect ATS provider from URL host/path patterns.
 * @param {string} formUrl
 * @returns {'workday'|'greenhouse'|'lever'|'generic'}
 */
export function detectAtsFromUrl(formUrl = '') {
  const raw = String(formUrl || '').trim().toLowerCase();
  let host = '';
  let pathAndQuery = raw;
  try {
    const u = new URL(raw);
    host = u.hostname;
    pathAndQuery = `${u.hostname}${u.pathname}${u.search}`;
  } catch {
    /* keep raw */
  }

  if (
    /myworkdayjobs\.com/.test(host) ||
    /\.wd\d+\.myworkdayjobs\.com/.test(host) ||
    /workday\.com/.test(host) ||
    /myworkday\.com/.test(host)
  ) {
    return ATS.WORKDAY;
  }

  if (
    /boards\.greenhouse\.io/.test(host) ||
    /job-boards\.greenhouse\.io/.test(host) ||
    /grnh\.se/.test(host) ||
    /greenhouse\.io/.test(host)
  ) {
    return ATS.GREENHOUSE;
  }

  if (/jobs\.lever\.co/.test(host) || /(^|\.)lever\.co$/.test(host)) {
    return ATS.LEVER;
  }

  // Path-based fallbacks (embedded widgets / redirects)
  if (/workday|myworkdayjobs/.test(pathAndQuery)) return ATS.WORKDAY;
  if (/greenhouse|grnh\.se/.test(pathAndQuery)) return ATS.GREENHOUSE;
  if (/jobs\.lever\.co|lever\.co\/.+\/.+/.test(pathAndQuery)) return ATS.LEVER;

  return ATS.GENERIC;
}

/**
 * Inspect the live DOM for ATS fingerprints when URL is ambiguous.
 * @param {import('playwright').Page} page
 * @returns {Promise<'workday'|'greenhouse'|'lever'|'generic'>}
 */
export async function detectAtsFromDom(page) {
  try {
    const signals = await page.evaluate(() => {
      const html = (document.documentElement?.innerHTML || '').slice(0, 200000);
      const href = location.href || '';
      const has = (re) => re.test(html) || re.test(href);
      return {
        workday:
          has(/workday|wd-CommandButton| fortizone|data-automation-id/i) ||
          Boolean(
            document.querySelector(
              '[data-automation-id], [data-uxi-element-id], css-1q2dra3'
            )
          ),
        greenhouse:
          has(/greenhouse|grnh/i) ||
          Boolean(
            document.querySelector(
              '#application_form, #submit_app, .greenhouse-job-application, form#application'
            )
          ),
        lever:
          has(/lever\.co|postings-btn/i) ||
          Boolean(
            document.querySelector(
              '.application-form, .postings-btn, #application-form, .lever-job'
            )
          ),
      };
    });

    if (signals.workday) return ATS.WORKDAY;
    if (signals.greenhouse) return ATS.GREENHOUSE;
    if (signals.lever) return ATS.LEVER;
  } catch {
    /* page may be closed / cross-origin */
  }
  return ATS.GENERIC;
}

/**
 * Prefer URL detection; fall back to DOM when generic.
 * @param {string} formUrl
 * @param {import('playwright').Page} [page]
 */
export async function detectAts(formUrl, page) {
  const fromUrl = detectAtsFromUrl(formUrl);
  if (fromUrl !== ATS.GENERIC) return fromUrl;
  if (page) {
    const fromDom = await detectAtsFromDom(page);
    if (fromDom !== ATS.GENERIC) return fromDom;
  }
  return ATS.GENERIC;
}
