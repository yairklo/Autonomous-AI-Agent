import fs from 'node:fs';
import path from 'node:path';
import { config as appConfig } from '../config.js';

const DEFAULT_CONFIG_PATH = path.join(appConfig.root, 'config.json');
/** Persisted on the `data` volume so GUI edits survive Coolify redeploys. */
export const WHATSAPP_GROUPS_OVERRIDE_PATH = path.join(
  appConfig.root,
  'data',
  'whatsapp-groups.json'
);

/**
 * Normalize and dedupe group names (order preserved).
 * @param {unknown} groups
 * @returns {string[]}
 */
export function normalizeGroupNames(groups) {
  const seen = new Set();
  const out = [];
  for (const g of Array.isArray(groups) ? groups : []) {
    const name = String(g || '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/**
 * Resolve allow-listed WhatsApp groups: data/whatsapp-groups.json overrides config.json.
 * @param {object} raw - parsed config.json
 * @param {string} [overridePath]
 * @returns {{ groups: string[], source: 'override' | 'config' }}
 */
export function resolveWhatsappGroups(
  raw,
  overridePath = WHATSAPP_GROUPS_OVERRIDE_PATH
) {
  const fromConfig = normalizeGroupNames(raw?.whatsapp?.groups);
  if (overridePath && fs.existsSync(overridePath)) {
    try {
      const override = JSON.parse(fs.readFileSync(overridePath, 'utf8'));
      const groups = normalizeGroupNames(override?.groups);
      if (groups.length) {
        return { groups, source: 'override' };
      }
    } catch {
      /* fall through to config.json */
    }
  }
  return { groups: fromConfig, source: 'config' };
}

/**
 * Persist WhatsApp group allow-list to data/whatsapp-groups.json (GUI / API).
 * @param {string[]} groups
 * @param {object} [opts]
 * @param {string} [opts.overridePath]
 * @returns {{ groups: string[], path: string }}
 */
export function saveWhatsappGroups(groups, { overridePath, allowEmpty = false } = {}) {
  const cleaned = normalizeGroupNames(groups);
  if (!cleaned.length && !allowEmpty) {
    const err = new Error('At least one WhatsApp group name is required');
    err.code = 'JOBS_GROUPS_EMPTY';
    throw err;
  }
  const target = path.resolve(overridePath || WHATSAPP_GROUPS_OVERRIDE_PATH);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const payload = {
    groups: cleaned,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return { groups: cleaned, path: target };
}

/**
 * Load jobs pipeline config from config.json (groups allow-list; optional data override).
 * @param {string | { configPath?: string, overridePath?: string | null }} [configPath]
 */
export function loadJobsConfig(configPath = DEFAULT_CONFIG_PATH) {
  let overridePathOpt;
  if (configPath && typeof configPath === 'object') {
    overridePathOpt = configPath.overridePath;
    configPath = configPath.configPath || DEFAULT_CONFIG_PATH;
  }
  const resolved = path.resolve(configPath || DEFAULT_CONFIG_PATH);
  if (!fs.existsSync(resolved)) {
    const err = new Error(`Jobs config not found: ${resolved}`);
    err.code = 'JOBS_CONFIG_NOT_FOUND';
    throw err;
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (cause) {
    const err = new Error(`Invalid jobs config JSON: ${resolved}`);
    err.code = 'JOBS_CONFIG_INVALID';
    err.cause = cause;
    throw err;
  }

  const isDefaultConfig = resolved === path.resolve(DEFAULT_CONFIG_PATH);
  const localOverridePath = isDefaultConfig
    ? WHATSAPP_GROUPS_OVERRIDE_PATH
    : path.join(path.dirname(resolved), 'data', 'whatsapp-groups.json');
  // Only apply workspace data/whatsapp-groups.json for the default config so
  // temp/test configs are not polluted by a live GUI override.
  const groupsInfo = resolveWhatsappGroups(
    raw,
    overridePathOpt !== undefined
      ? overridePathOpt
      : isDefaultConfig || fs.existsSync(localOverridePath)
        ? localOverridePath
        : null
  );

  const groups = groupsInfo.groups;
  if (!groups.length) {
    const err = new Error('config.json whatsapp.groups must list at least one group');
    err.code = 'JOBS_CONFIG_INVALID';
    throw err;
  }

  return {
    path: resolved,
    groupsSource: groupsInfo.source,
    groupsOverridePath:
      groupsInfo.source === 'override' ? localOverridePath : null,
    whatsapp: {
      groups,
      scanMode: raw.whatsapp?.scanMode || 'realtime',
      textOnly: raw.whatsapp?.textOnly !== false,
      neverSendMessages: raw.whatsapp?.neverSendMessages !== false,
    },
    roles: Array.isArray(raw.roles) ? raw.roles.map(String) : ['Full Stack', 'Backend', 'Frontend', 'מפתח'],
    telegram: {
      enabled: raw.telegram?.enabled !== false,
      botToken:
        process.env[raw.telegram?.botTokenEnv || 'TELEGRAM_BOT_TOKEN'] ||
        process.env.TELEGRAM_BOT_TOKEN ||
        '',
      chatId:
        process.env[raw.telegram?.chatIdEnv || 'TELEGRAM_CHAT_ID'] ||
        process.env.TELEGRAM_CHAT_ID ||
        '',
      requireApproval: raw.telegram?.requireApproval !== false,
    },
    submission: {
      channel: raw.submission?.channel || 'playwright_forms_only',
      neverWhatsappDmOrReply: raw.submission?.neverWhatsappDmOrReply !== false,
      delayBetweenSubmissionsMs: Number(
        raw.submission?.delayBetweenSubmissionsMs ?? 45000
      ),
      llmCoverLetter: raw.submission?.llmCoverLetter !== false,
      notifyTelegramOnFailure: raw.submission?.notifyTelegramOnFailure !== false,
    },
    profile: {
      path: resolveMaybeRelative(
        raw.profile?.path || 'data/cv-profile.json',
        appConfig.root
      ),
      cvPath: resolveMaybeRelative(
        raw.profile?.cvPath || 'assets/cv.pdf',
        appConfig.root
      ),
    },
    storage: {
      localOnly: raw.storage?.localOnly !== false,
      jobsDbPath: resolveMaybeRelative(
        raw.storage?.jobsDbPath || 'data/jobs-db.json',
        appConfig.root
      ),
      applicationsDir: resolveMaybeRelative(
        raw.storage?.applicationsDir || 'data/cv-applications',
        appConfig.root
      ),
    },
    safety: {
      neverSendWhatsappGroupMessages:
        raw.safety?.neverSendWhatsappGroupMessages !== false,
      neverSubmitWithoutTelegramApproval:
        raw.safety?.neverSubmitWithoutTelegramApproval !== false,
    },
  };
}

function resolveMaybeRelative(p, root) {
  const s = String(p || '').trim();
  if (!s) return path.join(root, 'data');
  return path.isAbsolute(s) ? s : path.join(root, s);
}

/**
 * Return true if groupName is in the allow-list from config.json.
 */
export function isAllowedGroup(groupName, jobsConfig) {
  const name = String(groupName || '').trim().toLowerCase();
  if (!name) return false;
  const groups = jobsConfig?.whatsapp?.groups || [];
  return groups.some((g) => {
    const gLower = String(g).toLowerCase();
    return name === gLower || name.includes(gLower) || gLower.includes(name);
  });
}
