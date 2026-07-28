#!/usr/bin/env node
/**
 * Ensure every registered coding workspace exists as a local git clone
 * (Coolify / Docker). Sources: workspaces.json (+ env path overrides).
 *
 * - Creates /workspaces if needed
 * - Clones each workspace gitRepo when missing
 * - Configures non-interactive git push via GITHUB_TOKEN credential helper
 * - Sets local git user.name / user.email when absent
 *
 * Usage:
 *   node scripts/bootstrap-workspace.js
 *   npm run bootstrap:workspace
 *
 * Env:
 *   AGENT_PROJECT_ROOT / JOINUP_PROJECT_ROOT / PORTFOLIO_PROJECT_ROOT / ECODRIVE_PROJECT_ROOT
 *   GITHUB_TOKEN          fine-grained or classic PAT with repo + contents:write
 *   GIT_AUTHOR_NAME / GIT_AUTHOR_EMAIL  (or GIT_USER_NAME / GIT_USER_EMAIL)
 *   WORKSPACE_BOOTSTRAP_SKIP=1   skip entirely
 *   WORKSPACE_BOOTSTRAP_STRICT=1 fail process if clone/auth cannot be ensured
 *   WORKSPACES_FILE / WORKSPACES_JSON  optional registry override
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  isGitRepo,
  listWorkspaces,
  resolveWorkspaceRoot,
} from '../server/workspaces.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

loadDotEnv(path.join(repoRoot, '.env'));

const skip = ['1', 'true', 'yes'].includes(
  String(process.env.WORKSPACE_BOOTSTRAP_SKIP || '').toLowerCase()
);
const strict =
  ['1', 'true', 'yes'].includes(
    String(process.env.WORKSPACE_BOOTSTRAP_STRICT || '').toLowerCase()
  ) ||
  (process.env.NODE_ENV === 'production' &&
    (String(process.env.JOINUP_PROJECT_ROOT || '').startsWith('/workspaces') ||
      String(process.env.AGENT_PROJECT_ROOT || '').startsWith('/workspaces')));

const token = String(process.env.GITHUB_TOKEN || '').trim();

function log(msg) {
  console.log(`[bootstrap-workspace] ${msg}`);
}

function warn(msg) {
  console.warn(`[bootstrap-workspace] ${msg}`);
}

function fail(msg, code = 'WORKSPACE_BOOTSTRAP_FAILED') {
  const err = new Error(msg);
  err.code = code;
  throw err;
}

function loadDotEnv(filePath) {
  try {
    if (!fs.existsSync(filePath)) return;
    const text = fs.readFileSync(filePath, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
  } catch {
    /* ignore */
  }
}

function gitGlobal(args) {
  execFileSync('git', ['config', '--global', ...args], {
    stdio: 'ignore',
    env: process.env,
  });
}

function gitLocal(dir, args) {
  execFileSync('git', ['-C', dir, 'config', ...args], { stdio: 'ignore' });
}

function gitLocalGet(dir, key) {
  try {
    return execFileSync('git', ['-C', dir, 'config', '--get', key], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return '';
  }
}

function ensureCredentialHelper() {
  if (!token) {
    warn(
      'GITHUB_TOKEN is not set — git clone/push over HTTPS may prompt or fail. Set it in Coolify env.'
    );
    return;
  }

  const helperJs = path
    .join(__dirname, 'git-credential-github-env.js')
    .replace(/\\/g, '/');
  const nodeBin = process.execPath.replace(/\\/g, '/');
  const helper = `!${nodeBin} ${helperJs}`;
  try {
    try {
      execFileSync(
        'git',
        ['config', '--global', '--unset-all', 'credential.helper'],
        {
          stdio: 'ignore',
          env: process.env,
        }
      );
    } catch {
      /* none set */
    }
    gitGlobal(['--add', 'credential.helper', helper]);
    gitGlobal(['credential.UseHttpPath', 'true']);
    log(`Configured git credential.helper → ${helperJs}`);
  } catch (err) {
    warn(`Could not set credential.helper: ${err.message}`);
  }

  process.env.GITHUB_TOKEN = token;
  process.env.GH_TOKEN = process.env.GH_TOKEN || token;
}

function authenticatedCloneUrl(url) {
  if (!token) return url;
  if (url.startsWith('https://github.com/')) {
    return url.replace(
      'https://github.com/',
      `https://x-access-token:${encodeURIComponent(token)}@github.com/`
    );
  }
  if (url.startsWith('https://')) {
    return url.replace(
      'https://',
      `https://x-access-token:${encodeURIComponent(token)}@`
    );
  }
  return url;
}

/**
 * @param {{ id: string, label?: string, gitRepo: string, root: string }} ws
 */
function ensureGitWorkspace(ws) {
  const projectRoot = ws.root;
  const gitRepo = ws.gitRepo;
  const label = ws.label || ws.id;

  if (!projectRoot) {
    fail(`Workspace ${ws.id} has no resolved root path`);
  }

  if (isGitRepo(projectRoot)) {
    log(`OK: ${label} git repo at ${projectRoot}`);
    ensureGitIdentityFor(projectRoot);
    verifyPushAuthHint(projectRoot);
    return { id: ws.id, root: projectRoot, ok: true };
  }

  // Running agent checkout on Windows: already the autonomous-agent tree.
  if (
    ws.id === 'autonomous-agent' &&
    path.resolve(projectRoot) === path.resolve(repoRoot) &&
    isGitRepo(repoRoot)
  ) {
    log(`OK: autonomous-agent using running checkout ${repoRoot}`);
    ensureGitIdentityFor(repoRoot);
    return { id: ws.id, root: repoRoot, ok: true };
  }

  if (fs.existsSync(projectRoot)) {
    const entries = fs.readdirSync(projectRoot);
    if (entries.length > 0) {
      fail(
        `${projectRoot} exists but is not a git repository (and is not empty). Move/remove it or set the workspace rootEnv for ${ws.id}.`
      );
    }
  }

  const parent = path.dirname(projectRoot);
  fs.mkdirSync(parent, { recursive: true });

  if (!token && gitRepo.startsWith('https://')) {
    fail(
      `Cannot clone ${gitRepo} → ${projectRoot}: set GITHUB_TOKEN in Coolify (repo read access).`
    );
  }

  const cloneUrl = authenticatedCloneUrl(gitRepo);
  log(`Cloning ${label}: ${gitRepo} → ${projectRoot}`);
  try {
    execFileSync('git', ['clone', '--', cloneUrl, projectRoot], {
      stdio: 'inherit',
      env: process.env,
    });
  } catch (err) {
    fail(`git clone failed for ${ws.id}: ${err.message}`);
  }

  try {
    execFileSync(
      'git',
      ['-C', projectRoot, 'remote', 'set-url', 'origin', gitRepo],
      { stdio: 'ignore' }
    );
    log(`Set origin → ${gitRepo} (auth via GITHUB_TOKEN credential helper)`);
  } catch {
    /* ignore */
  }

  ensureGitIdentityFor(projectRoot);
  verifyPushAuthHint(projectRoot);
  return { id: ws.id, root: projectRoot, ok: true };
}

function ensureGitIdentityFor(projectRoot) {
  const name =
    process.env.GIT_AUTHOR_NAME ||
    process.env.GIT_USER_NAME ||
    process.env.GIT_NAME ||
    '';
  const email =
    process.env.GIT_AUTHOR_EMAIL ||
    process.env.GIT_USER_EMAIL ||
    process.env.GIT_EMAIL ||
    '';

  if (name) {
    try {
      gitGlobal(['user.name', name]);
    } catch {
      /* ignore */
    }
  }
  if (email) {
    try {
      gitGlobal(['user.email', email]);
    } catch {
      /* ignore */
    }
  }

  if (!isGitRepo(projectRoot)) return;

  const localName = gitLocalGet(projectRoot, 'user.name');
  const localEmail = gitLocalGet(projectRoot, 'user.email');

  if (!localName) {
    const fallback = name || 'Autonomous Agent';
    gitLocal(projectRoot, ['user.name', fallback]);
    log(`Set local user.name=${fallback} (${projectRoot})`);
  }
  if (!localEmail) {
    const fallback = email || 'agent@localhost';
    gitLocal(projectRoot, ['user.email', fallback]);
    log(`Set local user.email=${fallback} (${projectRoot})`);
  }

  try {
    gitLocal(projectRoot, ['push.autoSetupRemote', 'true']);
  } catch {
    /* older git */
  }
}

function verifyPushAuthHint(projectRoot) {
  if (!isGitRepo(projectRoot)) return;
  try {
    const remote = execFileSync(
      'git',
      ['-C', projectRoot, 'remote', 'get-url', 'origin'],
      { encoding: 'utf8' }
    ).trim();
    log(`origin=${remote}`);
  } catch {
    warn(`No git origin configured at ${projectRoot}`);
  }
  if (token) {
    log('GITHUB_TOKEN is set — HTTPS git push should be non-interactive');
  }
}

function collectWorkspaceTargets() {
  const list = listWorkspaces({ forceReload: true });
  if (!list.length) {
    // Backward-compatible single JoinUp target
    const root =
      process.env.JOINUP_PROJECT_ROOT ||
      (process.platform === 'win32' ? 'C:\\JoinUpApp' : '/workspaces/JoinUpApp');
    const gitRepo =
      process.env.JOINUP_GIT_REPO ||
      `https://github.com/${String(process.env.JOINUP_GITHUB_REPO || 'yairklo/JoinUpApp').replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '')}.git`;
    return [
      {
        id: 'joinup',
        label: 'JoinUp',
        gitRepo,
        root: path.resolve(root),
      },
    ];
  }

  return list.map((ws) => ({
    id: ws.id,
    label: ws.label,
    gitRepo: ws.gitRepo,
    root: resolveWorkspaceRoot(ws),
  }));
}

export async function bootstrapWorkspace() {
  if (skip) {
    log('WORKSPACE_BOOTSTRAP_SKIP=1 — skipping');
    return { skipped: true, results: [] };
  }

  const targets = collectWorkspaceTargets();
  log(`Bootstrapping ${targets.length} workspace(s)`);
  for (const t of targets) {
    log(`  - ${t.id}: ${t.root} ← ${t.gitRepo}`);
  }

  ensureCredentialHelper();

  const results = [];
  try {
    for (const t of targets) {
      // Skip re-cloning the running agent tree into a nested path when roots match
      if (
        t.id === 'autonomous-agent' &&
        process.platform === 'win32' &&
        isGitRepo(repoRoot) &&
        (!t.root || path.resolve(t.root) === path.resolve(repoRoot))
      ) {
        log(`OK: autonomous-agent = running checkout ${repoRoot}`);
        ensureGitIdentityFor(repoRoot);
        results.push({ id: t.id, root: repoRoot, ok: true, skippedClone: true });
        continue;
      }
      results.push(ensureGitWorkspace(t));
    }
  } catch (err) {
    if (strict) throw err;
    warn(`${err.message} (non-strict; continuing)`);
    return { ok: false, results, error: err.message };
  }

  log('Workspace bootstrap complete');
  return { ok: true, results };
}

const isMain =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  bootstrapWorkspace()
    .then((r) => {
      if (r?.ok === false && strict) process.exit(1);
    })
    .catch((err) => {
      console.error(`[bootstrap-workspace] ✗ ${err.message}`);
      process.exit(1);
    });
}
