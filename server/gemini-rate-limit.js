/**
 * Shared Gemini free-tier gate: FIFO queue + RPM spacing + 429 backoff with jitter.
 * Quotas are per Google project — one limiter for voice + joinUp + any Gemini callers.
 */

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
      return;
    }
    let t;
    const onAbort = () => {
      clearTimeout(t);
      reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
    };
    t = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

export function isRateLimitError(err) {
  if (!err) return false;
  const status = err.status ?? err.statusCode ?? err.code ?? err?.error?.code;
  if (status === 429 || status === '429' || status === 'RESOURCE_EXHAUSTED') {
    return true;
  }
  const msg = String(err.message || err || '');
  return /429|RESOURCE_EXHAUSTED|rate.?limit|quota|too many requests/i.test(msg);
}

export function isDailyQuotaError(err) {
  const msg = String(err?.message || err || '');
  return /per day|daily|RPD|quota.*day|exceeded your current quota/i.test(msg);
}

/**
 * Full-jitter exponential backoff delay in ms.
 * @param {number} attempt 0-based
 * @param {{ baseMs?: number, capMs?: number, retryAfterMs?: number|null }} [opts]
 */
export function backoffDelayMs(attempt, opts = {}) {
  const baseMs = opts.baseMs ?? 1000;
  const capMs = opts.capMs ?? 60_000;
  if (opts.retryAfterMs != null && Number.isFinite(opts.retryAfterMs) && opts.retryAfterMs > 0) {
    return Math.min(capMs, opts.retryAfterMs);
  }
  const exp = Math.min(capMs, baseMs * 2 ** attempt);
  return Math.floor(Math.random() * (exp + 1));
}

export function parseRetryAfterMs(err) {
  const headers = err?.headers || err?.response?.headers;
  let raw = null;
  if (headers && typeof headers.get === 'function') {
    raw = headers.get('retry-after');
  } else if (headers && typeof headers === 'object') {
    raw = headers['retry-after'] || headers['Retry-After'];
  }
  if (raw == null && err?.retryDelay) raw = err.retryDelay;
  if (raw == null) return null;
  const asNum = Number(raw);
  if (Number.isFinite(asNum) && asNum >= 0) {
    // Gemini sometimes reports seconds as number; Retry-After is seconds.
    return asNum < 1000 ? asNum * 1000 : asNum;
  }
  const asDate = Date.parse(String(raw));
  if (!Number.isNaN(asDate)) return Math.max(0, asDate - Date.now());
  return null;
}

export class GeminiRateLimiter {
  /**
   * @param {object} [options]
   * @param {number} [options.rpm] requests per minute (default 15)
   * @param {number} [options.rpd] requests per day soft cap (default 1500); 0 = disable
   * @param {number} [options.maxRetries] 429 retries (default 6)
   * @param {number} [options.baseMs]
   * @param {number} [options.capMs]
   * @param {(line: string) => void} [options.onLog]
   */
  constructor(options = {}) {
    this.rpm = Math.max(1, Number(options.rpm) || 15);
    this.rpd = Math.max(0, Number(options.rpd) || 1500);
    this.minIntervalMs = Math.ceil(60_000 / this.rpm);
    this.maxRetries = Math.max(0, Number(options.maxRetries) || 6);
    this.baseMs = options.baseMs ?? 1000;
    this.capMs = options.capMs ?? 60_000;
    this.onLog = options.onLog || (() => {});
    this._chain = Promise.resolve();
    this._lastStartAt = 0;
    this._dayKey = '';
    this._dayCount = 0;
    this.stats = { queued: 0, completed: 0, rateLimited: 0, failed: 0 };
  }

  _rollDay() {
    // Free-tier RPD typically resets midnight Pacific.
    const key = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
    if (key !== this._dayKey) {
      this._dayKey = key;
      this._dayCount = 0;
    }
  }

  /**
   * Run fn under the global queue + spacing + 429 retry policy.
   * @template T
   * @param {() => Promise<T>} fn
   * @param {{ signal?: AbortSignal }} [opts]
   * @returns {Promise<T>}
   */
  schedule(fn, { signal } = {}) {
    this.stats.queued += 1;
    const run = this._chain.then(() => this._run(fn, signal));
    // Keep queue alive even if one call fails.
    this._chain = run.catch(() => {});
    return run;
  }

  async _run(fn, signal) {
    this._rollDay();
    if (this.rpd > 0 && this._dayCount >= this.rpd) {
      this.stats.failed += 1;
      const err = new Error(
        `Gemini soft RPD cap reached (${this.rpd}/day Pacific). Try again after midnight PT.`
      );
      err.code = 'GEMINI_RPD_EXCEEDED';
      throw err;
    }

    const waitSpacing = Math.max(0, this.minIntervalMs - (Date.now() - this._lastStartAt));
    if (waitSpacing > 0) {
      this.onLog(`[gemini-rate-limit] spacing ${waitSpacing}ms (rpm=${this.rpm})`);
      await sleep(waitSpacing, signal);
    }

    let attempt = 0;
    while (true) {
      if (signal?.aborted) {
        throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
      }
      this._lastStartAt = Date.now();
      try {
        const result = await fn();
        this._dayCount += 1;
        this.stats.completed += 1;
        return result;
      } catch (err) {
        if (!isRateLimitError(err) || attempt >= this.maxRetries) {
          this.stats.failed += 1;
          throw err;
        }
        if (isDailyQuotaError(err) && attempt >= 1) {
          this.stats.failed += 1;
          err.code = err.code || 'GEMINI_RPD_EXCEEDED';
          throw err;
        }
        this.stats.rateLimited += 1;
        const delay = backoffDelayMs(attempt, {
          baseMs: this.baseMs,
          capMs: this.capMs,
          retryAfterMs: parseRetryAfterMs(err),
        });
        this.onLog(
          `[gemini-rate-limit] 429/backoff attempt=${attempt + 1}/${this.maxRetries} sleep=${delay}ms`
        );
        await sleep(delay, signal);
        attempt += 1;
      }
    }
  }
}

/** Process-wide limiter (voice + joinUp share free-tier quota). */
let sharedLimiter = null;

export function getSharedGeminiRateLimiter(options = {}) {
  if (!sharedLimiter) {
    sharedLimiter = new GeminiRateLimiter(options);
  }
  return sharedLimiter;
}

/** Test helper — reset singleton. */
export function _resetSharedGeminiRateLimiterForTests() {
  sharedLimiter = null;
}

export default GeminiRateLimiter;
