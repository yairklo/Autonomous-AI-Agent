import fs from 'node:fs';
import path from 'node:path';
import { config as appConfig } from '../config.js';

const DEFAULT_CONFIG_PATH = path.join(appConfig.root, 'config.json');

/**
 * Load jobs pipeline config from config.json (groups allow-list lives here only).
 * @param {string} [configPath]
 */
export function loadJobsConfig(configPath = DEFAULT_CONFIG_PATH) {
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

  const groups = Array.isArray(raw.whatsapp?.groups)
    ? raw.whatsapp.groups.map((g) => String(g).trim()).filter(Boolean)
    : [];
  if (!groups.length) {
    const err = new Error('config.json whatsapp.groups must list at least one group');
    err.code = 'JOBS_CONFIG_INVALID';
    throw err;
  }

  return {
    path: resolved,
    whatsapp: {
      groups,
      scanMode: raw.whatsapp?.scanMode || 'realtime',
      textOnly: raw.whatsapp?.textOnly !== false,
      neverSendMessages: raw.whatsapp?.neverSendMessages !== false,
    },
    roles: Array.isArray(raw.roles) ? raw.roles.map(String) : ['Full Stack', 'Backend'],
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
