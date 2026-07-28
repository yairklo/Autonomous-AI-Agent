/**
 * Multi-repo coding workspace registry (workspaces.json).
 * Bootstrap clones each entry; dispatch resolves path/alias → root + policy.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const agentRoot = path.resolve(__dirname, '..');

const DEFAULT_REGISTRY = {
  defaultWorkspaceId: 'autonomous-agent',
  workspaces: [
    {
      id: 'autonomous-agent',
      label: 'Autonomous AI Agent',
      gitRepo: 'https://github.com/yairklo/Autonomous-AI-Agent.git',
      rootEnv: 'AGENT_PROJECT_ROOT',
      defaultRoot: {
        linux: '/workspaces/Autonomous-AI-Agent',
        win32: 'C:\\Autonomous AI Agent',
      },
      aliases: ['/app', 'autonomous-agent', 'voice-agent'],
      dispatch: { mergeTarget: 'none', maxFixLoops: 5 },
    },
    {
      id: 'joinup',
      label: 'JoinUp',
      gitRepo: 'https://github.com/yairklo/JoinUpApp.git',
      rootEnv: 'JOINUP_PROJECT_ROOT',
      defaultRoot: {
        linux: '/workspaces/JoinUpApp',
        win32: 'C:\\JoinUpApp',
      },
      aliases: ['joinup', 'JoinUpApp'],
      dispatch: {
        mergeTarget: 'Dev',
        maxFixLoops: 5,
        agentTimeoutMs: 1200000,
      },
    },
  ],
};

let cached = null;

function normalizeRepoUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  if (raw.startsWith('https://') || raw.startsWith('git@')) {
    return raw.endsWith('.git') ? raw : `${raw}.git`;
  }
  const slug = raw
    .replace(/^https?:\/\/github\.com\//, '')
    .replace(/\.git$/, '');
  return `https://github.com/${slug}.git`;
}

/**
 * @param {string} [filePath]
 */
export function resolveWorkspacesFile(filePath) {
  const fromEnv = String(process.env.WORKSPACES_FILE || '').trim();
  if (filePath) return path.resolve(filePath);
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(agentRoot, 'workspaces.json');
}

/**
 * @param {{ filePath?: string, envSource?: NodeJS.ProcessEnv, forceReload?: boolean }} [opts]
 */
export function loadWorkspacesRegistry(opts = {}) {
  if (cached && !opts.forceReload && !opts.filePath && !opts.envSource) {
    return cached;
  }

  const envSource = opts.envSource || process.env;
  const jsonOverride = String(envSource.WORKSPACES_JSON || '').trim();
  let raw;

  if (jsonOverride) {
    raw = JSON.parse(jsonOverride);
  } else {
    const file = resolveWorkspacesFile(opts.filePath);
    if (fs.existsSync(file)) {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } else {
      raw = structuredClone(DEFAULT_REGISTRY);
    }
  }

  const workspaces = Array.isArray(raw?.workspaces) ? raw.workspaces : [];
  const normalized = workspaces
    .map((w) => normalizeWorkspaceEntry(w))
    .filter(Boolean);

  const registry = {
    defaultWorkspaceId:
      String(raw?.defaultWorkspaceId || normalized[0]?.id || '').trim() ||
      'autonomous-agent',
    workspaces: normalized,
    filePath: jsonOverride ? null : resolveWorkspacesFile(opts.filePath),
  };

  if (!opts.filePath && !opts.envSource) cached = registry;
  return registry;
}

function normalizeWorkspaceEntry(w) {
  if (!w || typeof w !== 'object') return null;
  const id = String(w.id || '').trim();
  if (!id) return null;
  const gitRepo = normalizeRepoUrl(w.gitRepo || w.repo || '');
  if (!gitRepo) return null;

  const defaultRoot =
    w.defaultRoot && typeof w.defaultRoot === 'object'
      ? {
          linux: String(w.defaultRoot.linux || w.defaultRoot.Linux || '').trim(),
          win32: String(w.defaultRoot.win32 || w.defaultRoot.windows || '').trim(),
        }
      : {
          linux: String(w.defaultRootLinux || '').trim(),
          win32: String(w.defaultRootWin32 || '').trim(),
        };

  const dispatch =
    w.dispatch && typeof w.dispatch === 'object' ? { ...w.dispatch } : {};

  return {
    id,
    label: String(w.label || id).trim(),
    gitRepo,
    rootEnv: String(w.rootEnv || '').trim(),
    defaultRoot,
    aliases: Array.isArray(w.aliases)
      ? w.aliases.map((a) => String(a).trim()).filter(Boolean)
      : [],
    dispatch: {
      mergeTarget:
        dispatch.mergeTarget != null
          ? String(dispatch.mergeTarget).trim()
          : 'none',
      maxFixLoops:
        dispatch.maxFixLoops != null ? Number(dispatch.maxFixLoops) : undefined,
      agentTimeoutMs:
        dispatch.agentTimeoutMs != null
          ? Number(dispatch.agentTimeoutMs)
          : undefined,
    },
  };
}

export function clearWorkspacesCache() {
  cached = null;
}

export function listWorkspaces(opts) {
  return loadWorkspacesRegistry(opts).workspaces;
}

export function getWorkspace(id, opts) {
  const want = String(id || '').trim();
  if (!want) return null;
  return (
    listWorkspaces(opts).find((w) => w.id === want) ||
    listWorkspaces(opts).find(
      (w) => w.id.toLowerCase() === want.toLowerCase()
    ) ||
    null
  );
}

export function getDefaultWorkspace(opts) {
  const reg = loadWorkspacesRegistry(opts);
  return getWorkspace(reg.defaultWorkspaceId, opts) || reg.workspaces[0] || null;
}

/**
 * Absolute root for a workspace entry (env override → platform default).
 * On Windows, if AGENT_PROJECT_ROOT unset and agentRoot is a git checkout,
 * prefer the running agent root for autonomous-agent.
 */
export function resolveWorkspaceRoot(workspace, opts = {}) {
  const envSource = opts.envSource || process.env;
  if (!workspace) return '';

  if (workspace.rootEnv) {
    const fromEnv = String(envSource[workspace.rootEnv] || '').trim();
    if (fromEnv) return path.resolve(fromEnv);
  }

  if (
    workspace.id === 'autonomous-agent' &&
    process.platform === 'win32' &&
    isGitRepo(agentRoot)
  ) {
    return agentRoot;
  }

  const platformKey = process.platform === 'win32' ? 'win32' : 'linux';
  const fallback =
    workspace.defaultRoot?.[platformKey] ||
    workspace.defaultRoot?.linux ||
    '';
  return fallback ? path.resolve(fallback) : '';
}

export function isGitRepo(dir) {
  try {
    if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      return false;
    }
    execFileSync('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Find workspace whose resolved root matches dir (exact).
 */
export function findWorkspaceByRoot(dir, opts) {
  const resolved = path.resolve(dir || '');
  if (!resolved) return null;
  for (const ws of listWorkspaces(opts)) {
    const root = resolveWorkspaceRoot(ws, opts);
    if (root && path.resolve(root) === resolved) return ws;
  }
  // Also match when dir is under a workspace root
  for (const ws of listWorkspaces(opts)) {
    const root = resolveWorkspaceRoot(ws, opts);
    if (!root) continue;
    const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
    if (resolved === root || resolved.startsWith(rootWithSep)) return ws;
  }
  return null;
}

/**
 * Match alias token (case-insensitive except path-like aliases).
 */
export function findWorkspaceByAlias(token, opts) {
  const raw = String(token || '').trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  for (const ws of listWorkspaces(opts)) {
    for (const alias of ws.aliases || []) {
      if (alias.startsWith('/') || alias.includes('\\')) {
        if (path.resolve(alias) === path.resolve(raw) || alias === raw) {
          return ws;
        }
        if (alias.toLowerCase() === lower) return ws;
      } else if (alias.toLowerCase() === lower) {
        return ws;
      }
    }
    if (ws.id.toLowerCase() === lower) return ws;
  }
  return null;
}

/**
 * Remap runtime image path (/app) or non-git agent root → coding workspace.
 * @param {string} candidate
 * @param {{ envSource?: NodeJS.ProcessEnv, agentRoot?: string }} [opts]
 */
export function remapCodingProjectPath(candidate, opts = {}) {
  const rootHint = opts.agentRoot || agentRoot;
  const raw = String(candidate || '').trim();
  const defaultWs = getDefaultWorkspace(opts);
  const defaultRoot = defaultWs
    ? resolveWorkspaceRoot(defaultWs, opts)
    : rootHint;

  if (!raw) return defaultRoot || rootHint;

  const resolved = path.resolve(raw);

  // Explicit alias / known non-git runtime paths
  const byAlias = findWorkspaceByAlias(raw, opts) || findWorkspaceByAlias(resolved, opts);
  if (byAlias) {
    return resolveWorkspaceRoot(byAlias, opts) || resolved;
  }

  // /app or identical to packaged agent root without .git → default coding ws
  const isAppPath =
    resolved === '/app' ||
    raw === '/app' ||
    resolved.replace(/\\/g, '/') === '/app';
  if (isAppPath) {
    return defaultRoot || resolved;
  }

  if (
    path.resolve(resolved) === path.resolve(rootHint) &&
    !isGitRepo(resolved) &&
    defaultRoot
  ) {
    return defaultRoot;
  }

  const byRoot = findWorkspaceByRoot(resolved, opts);
  if (byRoot) return resolveWorkspaceRoot(byRoot, opts) || resolved;

  return resolved;
}

/**
 * Resolve which workspace a free-text coding request targets.
 * @param {{ path?: string, text?: string, envSource?: NodeJS.ProcessEnv }} [opts]
 */
export function resolveWorkspaceFromPathOrText(opts = {}) {
  const text = String(opts.text || '');
  const pathHint = String(opts.path || '').trim();

  if (pathHint) {
    const remapped = remapCodingProjectPath(pathHint, opts);
    const ws =
      findWorkspaceByRoot(remapped, opts) ||
      findWorkspaceByAlias(pathHint, opts) ||
      getDefaultWorkspace(opts);
    return {
      workspace: ws,
      root: remapped || (ws ? resolveWorkspaceRoot(ws, opts) : ''),
    };
  }

  // Prefer longer aliases first
  const workspaces = listWorkspaces(opts);
  const aliasHits = [];
  for (const ws of workspaces) {
    for (const alias of [...(ws.aliases || []), ws.id, ws.label]) {
      if (!alias || alias.startsWith('/')) continue;
      const re = new RegExp(
        `(^|[^\\wא-ת])${escapeRegExp(alias)}([^\\wא-ת]|$)`,
        'i'
      );
      if (re.test(text)) {
        aliasHits.push({ ws, alias, len: alias.length });
      }
    }
  }
  aliasHits.sort((a, b) => b.len - a.len);
  if (aliasHits[0]) {
    const ws = aliasHits[0].ws;
    return { workspace: ws, root: resolveWorkspaceRoot(ws, opts) };
  }

  // Explicit filesystem path in text
  const pathMatch =
    text.match(/["']([A-Za-z]:[^"']+|\/[^"']+)["']/) ||
    text.match(/([A-Za-z]:[\\/][A-Za-z0-9 _.\-\\/]+)/) ||
    text.match(/(?:^|\s)((?:\/|\.\/)[A-Za-z0-9 _.\-\/]+)/);
  if (pathMatch?.[1]) {
    const remapped = remapCodingProjectPath(pathMatch[1].trim(), opts);
    const ws = findWorkspaceByRoot(remapped, opts) || getDefaultWorkspace(opts);
    return { workspace: ws, root: remapped };
  }

  const ws = getDefaultWorkspace(opts);
  return {
    workspace: ws,
    root: ws ? resolveWorkspaceRoot(ws, opts) : agentRoot,
  };
}

/**
 * Default absolute path for coding dispatch when unspecified.
 */
export function resolveCodingProjectRoot(opts = {}) {
  const { root } = resolveWorkspaceFromPathOrText({
    ...opts,
    path: opts.path,
    text: opts.text || '',
  });
  return root || agentRoot;
}

/**
 * Apply workspace.dispatch policy onto process.env for a dispatch run.
 * Does not override explicitly set global env when `respectExistingEnv` is true
 * and the caller already set DISPATCH_* — we only fill gaps from registry,
 * except mergeTarget always comes from workspace when known (JoinUp Dev).
 *
 * @param {object|null} workspace
 * @param {{ env?: NodeJS.ProcessEnv, forcePolicy?: boolean }} [opts]
 * @returns {NodeJS.ProcessEnv}
 */
export function applyWorkspaceDispatchPolicy(workspace, opts = {}) {
  const env = { ...(opts.env || process.env) };
  if (!workspace?.dispatch) return env;

  const d = workspace.dispatch;
  const force = opts.forcePolicy === true;

  if (d.mergeTarget != null && d.mergeTarget !== '') {
    if (force || !String(env.DISPATCH_MERGE_TARGET || '').trim()) {
      env.DISPATCH_MERGE_TARGET = String(d.mergeTarget);
    }
  }
  if (d.maxFixLoops != null && !Number.isNaN(d.maxFixLoops)) {
    if (force || !String(env.DISPATCH_MAX_FIX_LOOPS || '').trim()) {
      env.DISPATCH_MAX_FIX_LOOPS = String(d.maxFixLoops);
    }
  }
  if (d.agentTimeoutMs != null && !Number.isNaN(d.agentTimeoutMs)) {
    if (force || !String(env.DISPATCH_AGENT_TIMEOUT_MS || '').trim()) {
      env.DISPATCH_AGENT_TIMEOUT_MS = String(d.agentTimeoutMs);
    }
  }
  return env;
}

/**
 * Human-readable list for system prompts.
 */
export function formatWorkspacesForPrompt(opts) {
  const reg = loadWorkspacesRegistry(opts);
  const lines = reg.workspaces.map((ws) => {
    const root = resolveWorkspaceRoot(ws, opts);
    const merge = ws.dispatch?.mergeTarget || 'none';
    return `- ${ws.id} (${ws.label}): ${root || '(unresolved)'} [merge=${merge}] aliases=${(ws.aliases || []).join(', ') || '—'}`;
  });
  const def = reg.defaultWorkspaceId;
  return [
    'Registered coding workspaces (dispatch only to these git clones — never to a Docker /app image without .git):',
    ...lines,
    `Default when unspecified: ${def}.`,
  ].join('\n');
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export { agentRoot as workspacesAgentRoot };
