/**
 * Redeploy joinUp API staging on Render and listen until the *new* deploy is live.
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
 *   JOINUP_STAGING_GRACE_MS=90000   # min wait / wait-for-old-instance when no Render API key
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

export function parseRenderServiceIdFromHook(hookUrl) {
  const m = String(hookUrl || '').match(/\/deploy\/(srv-[A-Za-z0-9]+)/);
  return m?.[1] || '';
}

export function parseDeployIdFromHookBody(body) {
  const raw = String(body || '').trim();
  if (!raw) return '';
  try {
    const data = JSON.parse(raw);
    return (
      data.deployId ||
      data.id ||
      data.deploy?.id ||
      data.deploy?.deployId ||
      ''
    );
  } catch {
    const m = raw.match(/dpl[_-][A-Za-z0-9]+/);
    return m?.[0] || '';
  }
}

/**
 * Did the latest commits on this project touch server/ code?
 * @param {string} projectRoot
 * @param {string} [sinceRef] e.g. origin/Dev~1
 */
export function detectServerCodeChanges(projectRoot, sinceRef = 'HEAD~1') {
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
 *   graceMs?: number,
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
  const graceMs = Number(
    opts.graceMs ?? env('JOINUP_STAGING_GRACE_MS', '90000')
  );

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

  const triggeredAt = Date.now();
  const deadline = triggeredAt + timeoutMs;

  // Prefer authoritative Render deploy status when possible (avoids false green on old instance).
  let deployWatch = null;
  if (trigger.deployId && trigger.serviceId && env('RENDER_API_KEY')) {
    onLog(
      `[render-staging] waiting for Render deploy ${trigger.deployId} → live`
    );
    deployWatch = await waitForRenderDeployLive({
      fetchImpl,
      apiKey: env('RENDER_API_KEY'),
      serviceId: trigger.serviceId,
      deployId: trigger.deployId,
      deadline,
      pollMs,
      onLog,
    });
    if (!deployWatch.ok) {
      return {
        ok: false,
        skipped: false,
        stagingUrl,
        productionApiUrl: getJoinUpApiProductionUrl(),
        trigger,
        deploy: deployWatch,
        health: null,
        errors: deployWatch.errors || ['Render deploy did not become live'],
      };
    }
  } else {
    onLog(
      '[render-staging] no Render API deploy watch — waiting for rollout signal (downtime or grace) before trusting health'
    );
  }

  onLog(`[render-staging] watching health ${healthUrl}`);
  const health = await waitForHealthyAfterDeploy({
    fetchImpl,
    healthUrl,
    deadline,
    pollMs,
    graceMs: deployWatch?.ok ? Math.min(graceMs, 20000) : graceMs,
    triggeredAt,
    requireRolloutSignal: !deployWatch?.ok,
    onLog,
  });

  return {
    ok: health.ok,
    skipped: false,
    stagingUrl,
    productionApiUrl: getJoinUpApiProductionUrl(),
    trigger,
    deploy: deployWatch,
    health,
    errors: health.ok ? [] : health.errors || ['Staging health check failed'],
  };
}

async function triggerRenderDeploy({ fetchImpl, onLog }) {
  const hook = env('RENDER_STAGING_DEPLOY_HOOK_URL') || env('JOINUP_RENDER_DEPLOY_HOOK');
  const apiKey = env('RENDER_API_KEY');
  const serviceIdEnv =
    env('RENDER_STAGING_SERVICE_ID') || env('JOINUP_RENDER_SERVICE_ID');

  if (!hook && !(apiKey && serviceIdEnv)) {
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
      if (!res.ok && res.status !== 202) {
        return {
          ok: false,
          skipped: false,
          error: `Deploy hook HTTP ${res.status}: ${body.slice(0, 200)}`,
        };
      }
      const deployId = parseDeployIdFromHookBody(body);
      const serviceId = parseRenderServiceIdFromHook(hook) || serviceIdEnv;
      if (deployId) onLog(`[render-staging] deploy started id=${deployId}`);
      if (res.status === 202) {
        onLog(
          '[render-staging] hook 202 — another deploy in progress; will wait via health/API'
        );
      }
      return {
        ok: true,
        skipped: false,
        method: 'hook',
        status: res.status,
        deployId,
        serviceId,
        bodyPreview: body.slice(0, 200),
      };
    }

    onLog(`[render-staging] POST Render API deploy service=${serviceIdEnv}`);
    const res = await fetchImpl(
      `https://api.render.com/v1/services/${serviceIdEnv}/deploys`,
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
    const deployId = data?.id || data?.deploy?.id || '';
    return {
      ok: true,
      skipped: false,
      method: 'api',
      deployId,
      serviceId: serviceIdEnv,
    };
  } catch (err) {
    return { ok: false, skipped: false, error: err.message };
  }
}

async function waitForRenderDeployLive({
  fetchImpl,
  apiKey,
  serviceId,
  deployId,
  deadline,
  pollMs,
  onLog,
}) {
  /** @type {string[]} */
  const errors = [];
  while (Date.now() < deadline) {
    try {
      const res = await fetchImpl(
        `https://api.render.com/v1/services/${serviceId}/deploys/${deployId}`,
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            Accept: 'application/json',
          },
        }
      );
      const data = await res.json().catch(() => ({}));
      const status = data?.status || data?.deploy?.status || '';
      onLog(`[render-staging] deploy ${deployId} status=${status || res.status}`);
      if (!res.ok) {
        errors.push(`Render API HTTP ${res.status}`);
      } else if (status === 'live') {
        return { ok: true, status, deployId, errors: [] };
      } else if (
        /failed|canceled|deactivated/i.test(status)
      ) {
        return {
          ok: false,
          status,
          deployId,
          errors: [`Render deploy ${status}`],
        };
      }
    } catch (err) {
      errors.push(err.message);
      onLog(`[render-staging] deploy poll error: ${err.message}`);
    }
    await sleep(pollMs);
  }
  return {
    ok: false,
    timedOut: true,
    deployId,
    errors: errors.slice(-6).concat(['Timed out waiting for Render deploy live']),
  };
}

/**
 * Avoid false green: old Render instance stays healthy while the new build runs.
 * Require a rollout signal (health blip) or grace period, then consecutive OK polls.
 */
async function waitForHealthyAfterDeploy({
  fetchImpl,
  healthUrl,
  deadline,
  pollMs,
  graceMs,
  triggeredAt,
  requireRolloutSignal,
  onLog,
}) {
  /** @type {string[]} */
  const errors = [];
  let lastStatus = 0;
  let consecutiveOk = 0;
  let sawUnhealthy = false;
  let rolloutReady = !requireRolloutSignal;

  while (Date.now() < deadline) {
    const elapsed = Date.now() - triggeredAt;
    if (!rolloutReady) {
      if (sawUnhealthy) {
        rolloutReady = true;
        onLog(
          '[render-staging] rollout signal: instance went unhealthy — now waiting for new boot'
        );
        consecutiveOk = 0;
      } else if (elapsed >= graceMs) {
        rolloutReady = true;
        onLog(
          `[render-staging] grace ${graceMs}ms elapsed without downtime blip — accepting post-grace health only`
        );
        consecutiveOk = 0;
      }
    }

    try {
      const res = await fetchImpl(healthUrl, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      lastStatus = res.status;
      const text = await res.text().catch(() => '');
      if (res.ok) {
        if (!rolloutReady) {
          onLog(
            `[render-staging] health still OK on likely OLD instance (${res.status}) — waiting for deploy/rollout`
          );
          consecutiveOk = 0;
        } else {
          consecutiveOk += 1;
          onLog(
            `[render-staging] health OK (${res.status}) streak=${consecutiveOk}/3`
          );
          if (consecutiveOk >= 3) {
            return {
              ok: true,
              status: res.status,
              bodyPreview: text.slice(0, 200),
              waitedMs: Date.now() - triggeredAt,
              sawUnhealthy,
              errors: [],
            };
          }
        }
      } else {
        sawUnhealthy = true;
        consecutiveOk = 0;
        const msg = `health HTTP ${res.status}: ${text.slice(0, 160)}`;
        errors.push(msg);
        onLog(`[render-staging] ${msg}`);
      }
    } catch (err) {
      sawUnhealthy = true;
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
    sawUnhealthy,
    waitedMs: Date.now() - triggeredAt,
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
    if (staging.trigger.deployId) {
      lines.push(`Deploy ID: ${staging.trigger.deployId}`);
    }
  } else if (staging.trigger?.error) {
    lines.push(`רידיפלוי נכשל: ${staging.trigger.error}`);
  }
  if (staging.deploy?.status) {
    lines.push(`סטטוס Deploy ב-Render: ${staging.deploy.status}`);
  }
  if (staging.health?.ok) {
    const waited = staging.health.waitedMs
      ? ` (אחרי ${Math.round(staging.health.waitedMs / 1000)}ש)`
      : '';
    lines.push(`בריאות השרת אחרי העלאה: תקינה${waited}`);
  } else if (staging.errors?.length) {
    lines.push('שגיאות בשרת staging:');
    for (const e of staging.errors.slice(0, 3)) lines.push(`• ${e}`);
  }
  return lines;
}
