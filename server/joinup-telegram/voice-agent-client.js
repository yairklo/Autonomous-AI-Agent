/**
 * HTTP client from thin joinup-telegram → voice-agent /api/joinup/*.
 */
import { resolveVoiceAgentBaseUrl } from './voice-agent-url.js';

function sharedSecret() {
  return String(process.env.JOINUP_BOT_SHARED_SECRET || '').trim();
}

function baseUrl() {
  return resolveVoiceAgentBaseUrl().replace(/\/$/, '');
}

async function joinupFetch(pathname, { method = 'GET', body, signal } = {}) {
  const secret = sharedSecret();
  if (!secret) {
    const err = new Error('JOINUP_BOT_SHARED_SECRET is not set');
    err.code = 'JOINUP_BOT_SECRET_MISSING';
    throw err;
  }
  const url = `${baseUrl()}${pathname}`;
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-JoinUp-Bot-Secret': secret,
    },
    body: body != null ? JSON.stringify(body) : undefined,
    signal,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(
      data?.error || `voice-agent ${method} ${pathname} → ${res.status}`
    );
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export function clientIdForTelegramUser(userId) {
  return `joinup-tg:${userId}`;
}

export async function joinupChat({ userId, text, signal }) {
  return joinupFetch('/api/joinup/chat', {
    method: 'POST',
    body: { clientId: clientIdForTelegramUser(userId), text },
    signal,
  });
}

/** @returns {Promise<{ runId: string, status: string }>} */
export async function joinupDispatch({ userId, technicalPrompt, signal }) {
  return joinupFetch('/api/joinup/dispatch', {
    method: 'POST',
    body: {
      clientId: clientIdForTelegramUser(userId),
      ...(technicalPrompt ? { technicalPrompt } : {}),
    },
    signal,
  });
}

export async function joinupGetRun(runId, { signal } = {}) {
  return joinupFetch(`/api/joinup/runs/${encodeURIComponent(runId)}`, {
    method: 'GET',
    signal,
  });
}

export async function joinupReset({ userId, signal } = {}) {
  return joinupFetch('/api/joinup/reset', {
    method: 'POST',
    body: { clientId: clientIdForTelegramUser(userId) },
    signal,
  });
}

export async function joinupRedeployStaging({ force = true, signal } = {}) {
  return joinupFetch('/api/joinup/redeploy-staging', {
    method: 'POST',
    body: { force },
    signal,
  });
}

/**
 * Poll until completed/failed or timeout.
 * @returns {Promise<object>} final run payload
 */
export async function joinupPollRun(
  runId,
  {
    intervalMs = 4000,
    timeoutMs = Number(process.env.JOINUP_TELEGRAM_POLL_TIMEOUT_MS || 3_600_000),
    signal,
    onTick,
  } = {}
) {
  const started = Date.now();
  let attempt = 0;
  while (true) {
    if (signal?.aborted) {
      const err = new Error('poll aborted');
      err.code = 'ABORTED';
      throw err;
    }
    const status = await joinupGetRun(runId, { signal });
    onTick?.(status, attempt);
    if (status.status === 'completed' || status.status === 'failed') {
      return status;
    }
    if (Date.now() - started > timeoutMs) {
      const err = new Error(`Timed out waiting for run ${runId}`);
      err.code = 'JOINUP_POLL_TIMEOUT';
      err.lastStatus = status;
      throw err;
    }
    attempt += 1;
    const wait = Math.min(intervalMs * (1 + Math.floor(attempt / 5)), 15000);
    await new Promise((r) => setTimeout(r, wait));
  }
}

export async function waitForVoiceAgentHealth({
  maxAttempts = 10,
  baseDelayMs = 1000,
  onLog = console.log,
} = {}) {
  const url = `${baseUrl()}/api/health`;
  let lastErr = '';
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      const res = await fetch(url, { method: 'GET' });
      if (res.ok) {
        onLog(`[joinup-telegram] voice-agent healthy at ${url} (attempt ${i})`);
        return true;
      }
      lastErr = `HTTP ${res.status}`;
    } catch (err) {
      lastErr = err.message || String(err);
    }
    onLog(
      `[joinup-telegram] waiting for voice-agent ${url} (${i}/${maxAttempts}): ${lastErr}`
    );
    const delay = baseDelayMs * Math.min(2 ** (i - 1), 16);
    await new Promise((r) => setTimeout(r, delay));
  }
  const err = new Error(
    `voice-agent not healthy after ${maxAttempts} attempts: ${lastErr}`
  );
  err.code = 'VOICE_AGENT_UNHEALTHY';
  throw err;
}
