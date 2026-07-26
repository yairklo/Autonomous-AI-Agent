/**
 * Redeploy joinUp API staging on Render and listen until healthy (or errors).
 *
 * Env (.env in Autonomous AI Agent):
 *   JOINUP_STAGING_URL=https://my-app-staging-ijyp.onrender.com
 *   JOINUP_API_PRODUCTION_URL=https://joinup-api.duckdns.org
 *   RENDER_STAGING_DEPLOY_HOOK_URL=https://api.render.com/deploy/srv-...?key=...
 *     — or —
 *   RENDER_API_KEY=...
 *   RENDER_STAGING_SERVICE_ID=srv-...
 *
 *   JOINUP_STAGING_HEALTH_PATH=/api/health
 *   JOINUP_STAGING_WAIT_MS=420000
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function env(name, fallback = '') {
  const v = process.env[name];
  return v == null || v === '' ? fallback : String(v).trim();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function getJoinUpStagingUrl() {
  return env(
    'JOINUP_STAGING_URL',
    'https://my-app-staging-ijyp.onrender.com'
  ).replace(/\/$/, '');
}

export function getJoinUpApiProductionUrl() {
  return env(
    'JOINUP_API_PRODUCTION_URL',
    'https://joinup-api.duckdns.org'
  ).replace(/\/$/, '');
}

/**
 * Did the latest commits on this project touch server/ code?
 * @param {string} projectRoot
 * @param {string} [sinceRef] e.g. origin/Dev~1
 */
export function detectServerCodeChanges(projectRoot, sinceRef = 'HEAD~5') {
  try {
    const root = path.resolve(projectRoot);
    if (!fs.existsSync(path.join(root, '.git'))) return true;
    const out = execSync(`git diff --name-only ${sinceRef}...HEAD`, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const files = out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    const serverTouched = files.some(
      (f) =>
        f.startsWith('server/') ||
        f === 'server' ||
        /(^|\/)prisma\//.test(f) ||
        (f.endsWith('package.json') && f.includes('server'))
    );
    return { touched: serverTouched, files };
  } catch {
    // If git range fails, assume server may have changed (safe default).
    return { touched: true, files: [] };
  }
}

/**
 * Trigger Render redeploy + wait for staging health.
 * @param {{
 *   projectRoot?: string,
 *   force?: boolean,
 *   onLog?: (line: string) => void,
 *   fetchImpl?: typeof fetch,
 *   timeoutMs?: number,
 *   pollMs?: number,
 * }} [opts]
 */
export async function redeployAndWatchStaging(opts = {}) {
  const onLog = opts.onLog || ((l) => console.log(l));
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const stagingUrl = getJoinUpStagingUrl();
  const healthPath = env('JOINUP_STAGING_HEALTH_PATH', '/api/health');
  const healthUrl = `${stagingUrl}${healthPath.startsWith('/') ? '' : '/'}${healthPath}`;
  const timeoutMs = Number(
    opts.timeoutMs ?? env('JOINUP_STAGING_WAIT_MS', '420000')
  );
  const pollMs = Number(opts.pollMs || 10000);

  if (opts.projectRoot && !opts.force) {
    const changed = detectServerCodeChanges(opts.projectRoot);
    if (!changed.touched) {
      onLog('[render-staging] no server/ changes detected — skip redeploy');
      return {
        ok: true,
        skipped: true,
        reason: 'no_server_changes',
        stagingUrl,
        productionApiUrl: getJoinUpApiProductionUrl(),
      };
    }
    onLog(
      `[render-staging] server changes detected (${changed.files.length || '?'} files) — redeploying`
    );
  }

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    onLog('[render-staging] wait skipped (timeoutMs<=0)');
    return {
      ok: true,
      skipped: true,
      reason: 'timeout_disabled',
      stagingUrl,
      productionApiUrl: getJoinUpApiProductionUrl(),
    };
  }

  const trigger = await triggerRenderDeploy({ fetchImpl, onLog });
  if (!trigger.ok && !trigger.skipped) {
    return {
      ok: false,
      skipped: false,
      stagingUrl,
      productionApiUrl: getJoinUpApiProductionUrl(),
      trigger,
      health: null,
      errors: [trigger.error || 'Failed to trigger Render deploy'],
    };
  }

  onLog(`[render-staging] watching health ${healthUrl}`);
  const health = await waitForHealthy({
    fetchImpl,
    healthUrl,
    timeoutMs,
    pollMs,
    onLog,
  });

  return {
    ok: health.ok,
    skipped: false,
    stagingUrl,
    productionApiUrl: getJoinUpApiProductionUrl(),
    trigger,
    health,
    errors: health.ok ? [] : health.errors || ['Staging health check failed'],
  };
}

async function triggerRenderDeploy({ fetchImpl, onLog }) {
  const hook = env('RENDER_STAGING_DEPLOY_HOOK_URL') || env('JOINUP_RENDER_DEPLOY_HOOK');
  const apiKey = env('RENDER_API_KEY');
  const serviceId =
    env('RENDER_STAGING_SERVICE_ID') || env('JOINUP_RENDER_SERVICE_ID');

  if (!hook && !(apiKey && serviceId)) {
    onLog(
      '[render-staging] missing RENDER_STAGING_DEPLOY_HOOK_URL (or RENDER_API_KEY + RENDER_STAGING_SERVICE_ID) — skip trigger'
    );
    return {
      ok: false,
      skipped: true,
      error: 'Missing Render deploy credentials',
    };
  }

  try {
    if (hook) {
      onLog('[render-staging] POST deploy hook');
      const res = await fetchImpl(hook, { method: 'POST' });
      const body = await res.text().catch(() => '');
      if (!res.ok) {
        return {
          ok: false,
          skipped: false,
          error: `Deploy hook HTTP ${res.status}: ${body.slice(0, 200)}`,
        };
      }
      return { ok: true, skipped: false, method: 'hook', status: res.status };
    }

    onLog(`[render-staging] POST Render API deploy service=${serviceId}`);
    const res = await fetchImpl(
      `https://api.render.com/v1/services/${serviceId}/deploys`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ clearCache: 'do_not_clear' }),
      }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        ok: false,
        skipped: false,
        error: data?.message || `Render API HTTP ${res.status}`,
      };
    }
    return {
      ok: true,
      skipped: false,
      method: 'api',
      deployId: data?.id || data?.deploy?.id || '',
    };
  } catch (err) {
    return { ok: false, skipped: false, error: err.message };
  }
}

async function waitForHealthy({
  fetchImpl,
  healthUrl,
  timeoutMs,
  pollMs,
  onLog,
}) {
  const deadline = Date.now() + timeoutMs;
  /** @type {string[]} */
  const errors = [];
  let lastStatus = 0;
  let consecutiveOk = 0;

  // Give Render a moment to pick up the deploy before we declare failure on old instance.
  await sleep(Math.min(15000, pollMs));

  while (Date.now() < deadline) {
    try {
      const res = await fetchImpl(healthUrl, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      lastStatus = res.status;
      const text = await res.text().catch(() => '');
      if (res.ok) {
        consecutiveOk += 1;
        onLog(`[render-staging] health OK (${res.status}) streak=${consecutiveOk}`);
        // Require 2 OK responses — reduces false green during rolling restart.
        if (consecutiveOk >= 2) {
          return {
            ok: true,
            status: res.status,
            bodyPreview: text.slice(0, 200),
            errors: [],
          };
        }
      } else {
        consecutiveOk = 0;
        const msg = `health HTTP ${res.status}: ${text.slice(0, 160)}`;
        errors.push(msg);
        onLog(`[render-staging] ${msg}`);
      }
    } catch (err) {
      consecutiveOk = 0;
      const msg = `health error: ${err.message}`;
      errors.push(msg);
      onLog(`[render-staging] ${msg}`);
    }
    await sleep(pollMs);
  }

  return {
    ok: false,
    status: lastStatus,
    errors: errors.slice(-8),
    timedOut: true,
  };
}

/**
 * Telegram lines for staging redeploy result.
 */
export function formatStagingTelegramLines(staging) {
  if (!staging) return [];
  const lines = [
    'שרת staging (Render):',
    staging.stagingUrl || getJoinUpStagingUrl(),
  ];
  if (staging.skipped) {
    lines.push(`רידיפלוי: דולג (${staging.reason || 'skipped'})`);
    return lines;
  }
  if (staging.trigger?.skipped) {
    lines.push(
      'רידיפלוי: לא הוגדר Deploy Hook — הוסיפו RENDER_STAGING_DEPLOY_HOOK_URL ל-.env'
    );
  } else if (staging.trigger?.ok) {
    lines.push('רידיפלוי: הופעל');
  } else if (staging.trigger?.error) {
    lines.push(`רידיפלוי נכשל: ${staging.trigger.error}`);
  }
  if (staging.health?.ok) {
    lines.push('בריאות השרת: תקינה');
  } else if (staging.errors?.length) {
    lines.push('שגיאות בשרת staging:');
    for (const e of staging.errors.slice(0, 3)) lines.push(`• ${e}`);
  }
  return lines;
}
