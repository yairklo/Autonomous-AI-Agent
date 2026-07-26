/**
 * Resolve the Vercel *preview* URL for a specific git branch/commit (e.g. Dev),
 * the same kind of link GitHub PRs show ("Visit Preview") — NOT production.
 *
 * Preferred config (.env):
 *   VERCEL_TOKEN=...
 *   VERCEL_PROJECT_ID=...           # or VERCEL_PROJECT_NAME=
 *   VERCEL_TEAM_ID=...              # optional
 *   JOINUP_GITHUB_REPO=yairklo/JoinUpApp
 *   GITHUB_TOKEN=...                # optional fallback via GitHub Deployments / Checks
 *   JOINUP_VERCEL_BRANCH=Dev
 *
 * Never falls back to production unless JOINUP_VERCEL_ALLOW_PRODUCTION_FALLBACK=1.
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

function normalizeUrl(hostOrUrl) {
  if (!hostOrUrl) return '';
  const s = String(hostOrUrl).trim();
  if (!s) return '';
  return s.startsWith('http') ? s.replace(/\/$/, '') : `https://${s.replace(/\/$/, '')}`;
}

function isProductionHost(url) {
  const u = String(url || '').toLowerCase();
  // Stable production host for joinUp — never treat as the Dev preview link.
  return (
    u.includes('join-up-app.vercel.app') &&
    !u.includes('-git-') &&
    !/join-up-app-[a-z0-9]+-/i.test(u.replace('https://', ''))
  );
}

/**
 * @param {{
 *   gitBranch?: string,
 *   gitSha?: string,
 *   projectRoot?: string,
 *   token?: string,
 *   projectId?: string,
 *   projectName?: string,
 *   teamId?: string,
 *   githubToken?: string,
 *   githubRepo?: string,
 *   fetchImpl?: typeof fetch,
 *   timeoutMs?: number,
 *   pollMs?: number,
 *   allowProductionFallback?: boolean,
 *   onLog?: (line: string) => void,
 * }} [opts]
 */
export async function resolveJoinUpVercelUrl(opts = {}) {
  const onLog = opts.onLog || (() => {});
  const gitBranch = opts.gitBranch || env('JOINUP_VERCEL_BRANCH') || 'Dev';
  const projectRoot = opts.projectRoot || env('JOINUP_PROJECT_ROOT') || '';
  const gitSha =
    opts.gitSha ||
    env('JOINUP_GIT_SHA') ||
    (projectRoot ? resolveGitSha(projectRoot, gitBranch) : '');

  const token = opts.token || env('VERCEL_TOKEN');
  const projectId = opts.projectId || env('VERCEL_PROJECT_ID');
  const projectName =
    opts.projectName || env('VERCEL_PROJECT_NAME') || env('JOINUP_VERCEL_PROJECT');
  const teamId = opts.teamId || env('VERCEL_TEAM_ID');
  const githubToken = opts.githubToken || env('GITHUB_TOKEN') || env('GH_TOKEN');
  const githubRepo =
    opts.githubRepo || env('JOINUP_GITHUB_REPO') || 'yairklo/JoinUpApp';
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const rawTimeout =
    opts.timeoutMs !== undefined && opts.timeoutMs !== null
      ? opts.timeoutMs
      : env('JOINUP_VERCEL_WAIT_MS', '300000');
  const timeoutMs = Number(rawTimeout);
  const pollMs = Number(opts.pollMs || 8000);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    onLog('[vercel] wait skipped (timeoutMs<=0)');
    return emptyResult(gitBranch, gitSha);
  }
  const allowProductionFallback =
    opts.allowProductionFallback === true ||
    env('JOINUP_VERCEL_ALLOW_PRODUCTION_FALLBACK') === '1';

  /** @type {{ url: string, state?: string, inspectorUrl?: string, source?: string } | null} */
  let latest = null;
  const deadline = Date.now() + timeoutMs;

  const canVercel = Boolean(token && (projectId || projectName) && fetchImpl);
  const canGithub = Boolean(githubToken && githubRepo && fetchImpl);

  if (!canVercel && !canGithub) {
    onLog(
      '[vercel] Need VERCEL_TOKEN+VERCEL_PROJECT_ID (preferred) or GITHUB_TOKEN to resolve Dev preview URL'
    );
    return emptyResult(gitBranch, gitSha);
  }

  onLog(
    `[vercel] waiting for Dev preview branch=${gitBranch} sha=${gitSha?.slice(0, 7) || '?'}`
  );

  while (Date.now() < deadline) {
    try {
      if (canVercel) {
        latest = await fetchVercelPreviewDeployment({
          fetchImpl,
          token,
          projectId,
          projectName,
          teamId,
          gitBranch,
          gitSha,
        });
      }
      if ((!latest || !latest.url) && canGithub) {
        latest = await fetchGithubPreviewUrl({
          fetchImpl,
          githubToken,
          githubRepo,
          gitBranch,
          gitSha,
        });
      }

      if (latest?.url && isProductionHost(latest.url) && !allowProductionFallback) {
        onLog(`[vercel] ignoring production host ${latest.url}`);
        latest = null;
      }

      if (latest?.state === 'READY' && latest.url) {
        onLog(`[vercel] preview READY ${latest.url} (via ${latest.source})`);
        break;
      }
      if (latest?.state === 'ERROR' || latest?.state === 'CANCELED') {
        onLog(`[vercel] preview ${latest.state}`);
        break;
      }
      onLog(`[vercel] preview state=${latest?.state || 'pending'} — waiting…`);
    } catch (err) {
      onLog(`[vercel] poll error: ${err.message}`);
    }
    await sleep(pollMs);
  }

  if ((!latest?.url || isProductionHost(latest.url)) && allowProductionFallback) {
    const productionUrl = normalizeUrl(
      env('JOINUP_VERCEL_PRODUCTION_URL') || 'https://join-up-app.vercel.app'
    );
    return {
      ok: Boolean(productionUrl),
      url: productionUrl,
      deployUrl: '',
      productionUrl,
      state: 'PRODUCTION_FALLBACK',
      inspectorUrl: '',
      branch: gitBranch,
      sha: gitSha,
      source: 'production-fallback',
    };
  }

  const url = latest?.url && !isProductionHost(latest.url) ? latest.url : '';
  return {
    ok: Boolean(url) && (latest?.state === 'READY' || latest?.state === 'SUCCESS'),
    url,
    deployUrl: url,
    productionUrl: '',
    state: latest?.state || (url ? 'UNKNOWN' : 'MISSING'),
    inspectorUrl: latest?.inspectorUrl || '',
    branch: gitBranch,
    sha: gitSha,
    source: latest?.source || '',
  };
}

function emptyResult(gitBranch, gitSha) {
  return {
    ok: false,
    url: '',
    deployUrl: '',
    productionUrl: '',
    state: 'MISSING_CREDENTIALS',
    inspectorUrl: '',
    branch: gitBranch,
    sha: gitSha,
    source: '',
  };
}

function resolveGitSha(projectRoot, branch) {
  try {
    const root = path.resolve(projectRoot);
    if (!fs.existsSync(path.join(root, '.git'))) return '';
    return execSync(`git rev-parse origin/${branch}`, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    try {
      return execSync(`git rev-parse ${branch}`, {
        cwd: path.resolve(projectRoot),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      return '';
    }
  }
}

async function fetchVercelPreviewDeployment({
  fetchImpl,
  token,
  projectId,
  projectName,
  teamId,
  gitBranch,
  gitSha,
}) {
  // Do NOT set target=production — we want the branch preview deployment.
  const params = new URLSearchParams({ limit: '20' });
  if (projectId) params.set('projectId', projectId);
  if (projectName) params.set('app', projectName);
  if (teamId) params.set('teamId', teamId);
  // Vercel supports branch filter on some API versions
  if (gitBranch) params.set('branch', gitBranch);

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
        d.meta?.githubCommitRef ||
        d.meta?.gitlabCommitRef ||
        d.meta?.bitbucketCommitRef ||
        d.gitSource?.ref ||
        '';
      const metaSha = (d.meta?.githubCommitSha || d.gitSource?.sha || d.source?.sha || '')
        .toString()
        .toLowerCase();
      const branchOk =
        !gitBranch ||
        metaBranch === gitBranch ||
        metaBranch.toLowerCase() === gitBranch.toLowerCase();
      const shaOk =
        !gitSha ||
        metaSha.startsWith(gitSha.toLowerCase().slice(0, 7)) ||
        gitSha.toLowerCase().startsWith(metaSha.slice(0, 7));
      // Prefer matching both; accept branch-only if sha unknown.
      if (gitSha) return branchOk && shaOk;
      return branchOk && d.target !== 'production';
    }) ||
    list.find((d) => {
      const metaBranch =
        d.meta?.githubCommitRef || d.gitSource?.ref || '';
      return metaBranch === gitBranch && d.target !== 'production';
    });

  if (!match) return null;

  const host = match.url || match.alias?.[0] || '';
  const url = normalizeUrl(host);
  return {
    url,
    state: match.readyState || match.state || '',
    inspectorUrl:
      match.inspectorUrl ||
      (match.uid || match.id ? `https://vercel.com/deployments/${match.uid || match.id}` : ''),
    source: 'vercel-api',
  };
}

/**
 * Same preview URL GitHub shows on PRs / commit checks (Vercel integration).
 */
async function fetchGithubPreviewUrl({
  fetchImpl,
  githubToken,
  githubRepo,
  gitBranch,
  gitSha,
}) {
  const headers = {
    Authorization: `Bearer ${githubToken}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'joinup-telegram-bot',
  };
  const ref = gitSha || gitBranch;

  // 1) Commit check-runs (Vercel often posts "Vercel" with details_url / output).
  const checksRes = await fetchImpl(
    `https://api.github.com/repos/${githubRepo}/commits/${encodeURIComponent(ref)}/check-runs?per_page=20`,
    { headers }
  );
  if (checksRes.ok) {
    const checks = await checksRes.json().catch(() => ({}));
    const runs = Array.isArray(checks.check_runs) ? checks.check_runs : [];
    const vercelRun = runs.find(
      (r) =>
        /vercel/i.test(r.name || '') ||
        /vercel/i.test(r.app?.slug || '') ||
        /vercel/i.test(r.app?.name || '')
    );
    if (vercelRun) {
      const fromOutput = extractPreviewUrlFromText(
        `${vercelRun.output?.summary || ''}\n${vercelRun.output?.text || ''}\n${vercelRun.details_url || ''}`
      );
      if (fromOutput) {
        return {
          url: fromOutput,
          state: mapCheckConclusion(vercelRun.conclusion, vercelRun.status),
          inspectorUrl: vercelRun.details_url || '',
          source: 'github-check-runs',
        };
      }
    }
  }

  // 2) Deployments for the branch/sha → statuses.environment_url
  const depParams = new URLSearchParams({ per_page: '10' });
  if (gitSha) depParams.set('sha', gitSha);
  else depParams.set('ref', gitBranch);

  const depRes = await fetchImpl(
    `https://api.github.com/repos/${githubRepo}/deployments?${depParams}`,
    { headers }
  );
  if (!depRes.ok) return null;
  const deployments = await depRes.json().catch(() => []);
  const list = Array.isArray(deployments) ? deployments : [];
  const vercelDeps = list.filter(
    (d) =>
      /vercel/i.test(d.environment || '') ||
      /vercel/i.test(d.description || '') ||
      /vercel/i.test(d.task || '') ||
      d.payload?.web_url
  );
  const candidates = vercelDeps.length ? vercelDeps : list;

  for (const dep of candidates) {
    const stRes = await fetchImpl(
      `https://api.github.com/repos/${githubRepo}/deployments/${dep.id}/statuses`,
      { headers }
    );
    if (!stRes.ok) continue;
    const statuses = await stRes.json().catch(() => []);
    const stList = Array.isArray(statuses) ? statuses : [];
    const success = stList.find((s) => s.state === 'success' && s.environment_url);
    const any = stList.find((s) => s.environment_url);
    const pick = success || any;
    if (pick?.environment_url) {
      const url = normalizeUrl(pick.environment_url);
      if (isProductionHost(url)) continue;
      return {
        url,
        state: pick.state === 'success' ? 'READY' : String(pick.state || '').toUpperCase(),
        inspectorUrl: pick.log_url || dep.url || '',
        source: 'github-deployments',
      };
    }
  }

  // 3) Commit statuses (legacy)
  const statusRes = await fetchImpl(
    `https://api.github.com/repos/${githubRepo}/commits/${encodeURIComponent(ref)}/status`,
    { headers }
  );
  if (statusRes.ok) {
    const body = await statusRes.json().catch(() => ({}));
    for (const s of body.statuses || []) {
      if (!/vercel/i.test(s.context || '')) continue;
      const url = extractPreviewUrlFromText(`${s.target_url || ''}\n${s.description || ''}`);
      if (url && !isProductionHost(url)) {
        return {
          url,
          state: s.state === 'success' ? 'READY' : String(s.state || '').toUpperCase(),
          inspectorUrl: s.target_url || '',
          source: 'github-statuses',
        };
      }
    }
  }

  return null;
}

function mapCheckConclusion(conclusion, status) {
  if (status && status !== 'completed') return 'BUILDING';
  if (conclusion === 'success') return 'READY';
  if (conclusion === 'failure' || conclusion === 'cancelled') {
    return String(conclusion).toUpperCase();
  }
  return conclusion ? String(conclusion).toUpperCase() : 'PENDING';
}

function extractPreviewUrlFromText(text) {
  const raw = String(text || '');
  // Prefer non-production *.vercel.app URLs (preview / branch deployments).
  const matches = raw.match(/https?:\/\/[a-z0-9.-]+\.vercel\.app[^\s)\]>]*/gi) || [];
  for (const m of matches) {
    const url = normalizeUrl(m);
    if (!isProductionHost(url)) return url;
  }
  return '';
}

/**
 * Non-technical Telegram blurb — Dev preview only (PR-style build link).
 */
export function formatVercelTelegramLines(vercelInfo) {
  if (!vercelInfo?.url) {
    return [
      'קישור לבילד של Dev: עדיין לא מוכן / לא נמצא.',
      'צריך VERCEL_TOKEN + VERCEL_PROJECT_ID ב-.env (או GITHUB_TOKEN) כדי למשוך את קישור ה-preview כמו ב-PR.',
      vercelInfo?.state ? `סטטוס: ${vercelInfo.state}` : '',
    ].filter(Boolean);
  }
  const lines = [
    'קישור לבילד של ענף Dev (preview — לא פרודקשן):',
    vercelInfo.url,
  ];
  if (vercelInfo.state) lines.push(`סטטוס בילד: ${vercelInfo.state}`);
  if (vercelInfo.sha) lines.push(`קומיט: ${String(vercelInfo.sha).slice(0, 7)}`);
  if (vercelInfo.inspectorUrl) {
    lines.push('', `פרטי הבילד ב-Vercel: ${vercelInfo.inspectorUrl}`);
  }
  return lines;
}
