/**
 * GUI-facing track/untrack: resolve live WhatsApp group, sync Mongo + file allow-list.
 */

import {
  loadJobsConfig,
  saveWhatsappGroups,
  saveWhatsappGroupJid,
} from '../jobs/jobs-config.js';
import {
  listTrackedGroups,
  mongoReady,
  trackGroupByName,
  untrackGroupByName,
} from './group-store.js';
import { resolveWhatsappGroupByName } from './wa-resolve.js';
import { getSharedWhatsappSession } from '../whatsapp/session.js';
import { isGroupLikeJid } from '../whatsapp/groups.js';

function syncFileAllowList(names, { allowEmpty = false, overridePath } = {}) {
  return saveWhatsappGroups(names, { allowEmpty, overridePath });
}

/**
 * List groups for the Settings GUI (Mongo preferred, file fallback) + WA status.
 */
export async function listGroupsForGui() {
  const session = getSharedWhatsappSession();
  const snap = session.snapshot?.() || { state: 'uninitialized' };
  const fileCfg = loadJobsConfig();

  if (mongoReady()) {
    try {
      const tracked = await listTrackedGroups({ activeOnly: true });
      const names = tracked.map((g) => g.name).filter(Boolean);
      return {
        ok: true,
        source: 'mongo',
        groups: names,
        tracked,
        whatsapp: {
          state: snap.state,
          ready: snap.state === 'authenticated',
          error: snap.error || '',
        },
        fileGroups: fileCfg.whatsapp.groups,
      };
    } catch {
      /* fall through */
    }
  }

  return {
    ok: true,
    source: fileCfg.groupsSource || 'config',
    groups: fileCfg.whatsapp.groups,
    tracked: [],
    whatsapp: {
      state: snap.state,
      ready: snap.state === 'authenticated',
      error: snap.error || '',
    },
    fileGroups: fileCfg.whatsapp.groups,
  };
}

/**
 * Track a WhatsApp group for job matching + Telegram.
 * Prefer a live chat match when WhatsApp is authenticated; otherwise persist the
 * exact name to the file allow-list (and Mongo if connected) so ingest can match
 * by display name once messages arrive.
 */
export async function trackGroupFromGui(name, opts = {}) {
  const requested = String(name || '').trim();
  if (!requested) {
    return {
      ok: false,
      found: false,
      added: false,
      error: 'Group name required',
      code: 'GROUP_NAME_REQUIRED',
      message: 'name is required',
    };
  }

  const resolved = await resolveWhatsappGroupByName(requested, {
    session: opts.session,
    chats: opts.chats,
  });

  if (resolved.code === 'WA_GROUP_AMBIGUOUS') {
    return {
      ...resolved,
      ok: false,
      found: false,
      added: false,
    };
  }

  const foundLive = Boolean(resolved.found && resolved.match);
  const persistName = foundLive ? resolved.match.name : requested;
  const groupId = foundLive ? resolved.match.id || undefined : undefined;

  let mongoGroup = null;
  if (mongoReady()) {
    mongoGroup = await trackGroupByName(persistName, {
      addedBy: opts.addedBy || 'gui',
      groupId,
    });
  }

  const fileCfg = loadJobsConfig({ overridePath: opts.overridePath });
  const nextNames = [...fileCfg.whatsapp.groups, persistName];
  const saved = syncFileAllowList(nextNames, { overridePath: opts.overridePath });
  if (foundLive && isGroupLikeJid(groupId)) {
    try {
      saveWhatsappGroupJid(groupId, persistName, { overridePath: opts.overridePath });
    } catch {
      /* file jid map is best-effort */
    }
  }

  return {
    ok: true,
    found: foundLive,
    added: true,
    persistedByName: !foundLive,
    waState: resolved.waState,
    match: resolved.match || null,
    group: mongoGroup,
    groups: saved.groups,
    source: mongoGroup ? 'mongo+file' : 'file',
    message: foundLive
      ? resolved.match.exact
        ? `Found and added: ${persistName}`
        : `Found close match and added: ${persistName}`
      : `Added to tracked list by name: ${persistName}`,
  };
}

/**
 * Remove group from Mongo (active=false) + file allow-list.
 */
export async function untrackGroupFromGui(name, opts = {}) {
  const cleaned = String(name || '').trim();
  if (!cleaned) {
    return {
      ok: false,
      removed: false,
      error: 'Group name required',
      code: 'GROUP_NAME_REQUIRED',
    };
  }

  let mongoGroup = null;
  if (mongoReady()) {
    mongoGroup = await untrackGroupByName(cleaned);
  }

  const fileCfg = loadJobsConfig({ overridePath: opts.overridePath });
  const next = fileCfg.whatsapp.groups.filter(
    (g) => g.toLowerCase() !== cleaned.toLowerCase()
  );
  const wasInFile = next.length !== fileCfg.whatsapp.groups.length;
  if (!wasInFile && !mongoGroup) {
    return {
      ok: false,
      removed: false,
      error: `Group not found in tracked list: ${cleaned}`,
      code: 'GROUP_NOT_TRACKED',
      groups: fileCfg.whatsapp.groups,
    };
  }

  const saved = syncFileAllowList(next, {
    allowEmpty: true,
    overridePath: opts.overridePath,
  });
  return {
    ok: true,
    removed: true,
    group: mongoGroup,
    groups: saved.groups,
    message: `Removed: ${cleaned}`,
  };
}
