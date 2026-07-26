/**
 * Resolve a Vercel deployment URL after pushing to the joinUp deploy branch (Dev).
 *
 * Config (Autonomous AI Agent .env):
 *   JOINUP_VERCEL_PRODUCTION_URL=https://your-app.vercel.app   # always included
 *   VERCEL_TOKEN=...                                          # optional: poll latest READY deploy
 *   VERCEL_PROJECT_ID=...                                     # or VERCEL_PROJECT_NAME=
 *   VERCEL_TEAM_ID=...                                        # optional team/org scope
 */

function env(name, fallback = '') {
  const v = process.env[name];
  return v == null || v === '' ? fallback : String(v).trim();
}

/**
 * @param {{
 *   productionUrl?: string,
 *   token?: string,
 *   projectId?: string,
 *   projectName?: string,
 *   teamId?: string,
 *   gitBranch?: string,
 *   fetchImpl?: typeof fetch,
 *   timeoutMs?: number,
 *   pollMs?: number,
 *   onLog?: (line: string) => void,
 * }} [opts]
 */
export async function resolveJoinUpVercelUrl(opts = {}) {
  const onLog = opts.onLog || (() => {});
  const productionUrl = (
    opts.productionUrl ||
    env('JOINUP_VERCEL_PRODUCTION_URL') ||
    env('JOINUP_VERCEL_URL') ||
    // Known joinUp Vercel production host (override via env if it changes).
    'https://join-up-app.vercel.app'
  ).replace(/\/$/, '');

  const token = opts.token || env('VERCEL_TOKEN');
  const projectId = opts.projectId || env('VERCEL_PROJECT_ID');
  const projectName = opts.projectName || env('VERCEL_PROJECT_NAME') || env('JOINUP_VERCEL_PROJECT');
  const teamId = opts.teamId || env('VERCEL_TEAM_ID');
  const gitBranch = opts.gitBranch || env('JOINUP_VERCEL_BRANCH') || 'Dev';
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const timeoutMs = Number(opts.timeoutMs || env('JOINUP_VERCEL_WAIT_MS') || 300000);
  const pollMs = Number(opts.pollMs || 8000);

  /** @type {{ url: string, source: string, state?: string, inspectorUrl?: string } | null} */
  let latest = null;

  if (token && (projectId || projectName) && typeof fetchImpl === 'function') {
    const deadline = Date.now() + timeoutMs;
    onLog(
      `[vercel] polling deployments project=${projectId || projectName} branch=${gitBranch}`
    );
    while (Date.now() < deadline) {
      try {
        latest = await fetchLatestDeployment({
          fetchImpl,
          token,
          projectId,
          projectName,
          teamId,
          gitBranch,
        });
        if (latest?.state === 'READY' && latest.url) {
          onLog(`[vercel] READY ${latest.url}`);
          break;
        }
        if (latest?.state === 'ERROR' || latest?.state === 'CANCELED') {
          onLog(`[vercel] deploy ${latest.state}`);
          break;
        }
        onLog(`[vercel] state=${latest?.state || 'pending'} — waiting…`);
      } catch (err) {
        onLog(`[vercel] poll error: ${err.message}`);
      }
      await sleep(pollMs);
    }
  } else {
    onLog(
      '[vercel] VERCEL_TOKEN + VERCEL_PROJECT_ID/NAME not fully set — using production URL only'
    );
  }

  const deployUrl = latest?.url || '';
  const url = deployUrl || productionUrl;
  return {
    ok: Boolean(url) && (!latest || latest.state === 'READY' || !latest.state),
    url,
    productionUrl: productionUrl || '',
    deployUrl,
    state: latest?.state || (url ? 'ASSUMED' : 'UNKNOWN'),
    inspectorUrl: latest?.inspectorUrl || '',
    branch: gitBranch,
  };
}

async function fetchLatestDeployment({
  fetchImpl,
  token,
  projectId,
  projectName,
  teamId,
  gitBranch,
}) {
  const params = new URLSearchParams({
    limit: '10',
    target: 'production',
  });
  if (projectId) params.set('projectId', projectId);
  if (projectName) params.set('app', projectName);
  if (teamId) params.set('teamId', teamId);

  const res = await fetchImpl(`https://api.vercel.com/v6/deployments?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error?.message || `Vercel API ${res.status}`);
    err.code = 'VERCEL_API_ERROR';
    throw err;
  }

  const list = Array.isArray(data.deployments) ? data.deployments : [];
  const match =
    list.find((d) => {
      const metaBranch =
        d.meta?.githubCommitRef || d.meta?.gitlabCommitRef || d.meta?.bitbucketCommitRef;
      return !gitBranch || metaBranch === gitBranch || d.gitSource?.ref === gitBranch;
    }) || list[0];

  if (!match) return null;

  const host = match.url || match.alias?.[0] || '';
  const url = host ? (host.startsWith('http') ? host : `https://${host}`) : '';
  return {
    url,
    state: match.readyState || match.state || '',
    inspectorUrl: match.inspectorUrl || (match.uid ? `https://vercel.com/${match.uid}` : ''),
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Non-technical Telegram blurb that always includes a Vercel link when available.
 */
export function formatVercelTelegramLines(vercelInfo) {
  if (!vercelInfo?.url) {
    return [
      'קישור לגרסה באוויר: עדיין לא הוגדר.',
      'בקשו מהצוות להגדיר JOINUP_VERCEL_PRODUCTION_URL (ואופציונלי VERCEL_TOKEN) ב-.env.',
    ];
  }
  const lines = [
    'קישור לגרסה באוויר (Vercel):',
    vercelInfo.url,
  ];
  if (
    vercelInfo.productionUrl &&
    vercelInfo.deployUrl &&
    vercelInfo.productionUrl !== vercelInfo.deployUrl
  ) {
    lines.push('', `כתובת קבועה: ${vercelInfo.productionUrl}`);
  }
  if (vercelInfo.state && vercelInfo.state !== 'ASSUMED') {
    lines.push(`סטטוס בילד: ${vercelInfo.state}`);
  }
  return lines;
}
