/**
 * GUI-facing track/untrack: resolve live WhatsApp group, sync Mongo + file allow-list.
 */

import {
  loadJobsConfig,
  saveWhatsappGroups,
} from '../jobs/jobs-config.js';
import {
  listTrackedGroups,
  mongoReady,
  trackGroupByName,
  untrackGroupByName,
} from './group-store.js';
import { resolveWhatsappGroupByName } from './wa-resolve.js';
import { getSharedWhatsappSession } from '../whatsapp/session.js';

function syncFileAllowList(names, { allowEmpty = false } = {}) {
  return saveWhatsappGroups(names, { allowEmpty });
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
 * Search WhatsApp for group name; if found, track in Mongo + file allow-list.
 */
export async function trackGroupFromGui(name, opts = {}) {
  const resolved = await resolveWhatsappGroupByName(name, {
    session: opts.session,
    chats: opts.chats,
  });

  if (!resolved.found || !resolved.match) {
    return {
      ok: false,
      found: false,
      added: false,
      ...resolved,
    };
  }

  const matchedName = resolved.match.name;
  const groupId = resolved.match.id || undefined;

  let mongoGroup = null;
  if (mongoReady()) {
    mongoGroup = await trackGroupByName(matchedName, {
      addedBy: opts.addedBy || 'gui',
      groupId,
    });
  }

  const fileCfg = loadJobsConfig();
  const nextNames = [...fileCfg.whatsapp.groups, matchedName];
  const saved = syncFileAllowList(nextNames);

  return {
    ok: true,
    found: true,
    added: true,
    waState: resolved.waState,
    match: resolved.match,
    group: mongoGroup,
    groups: saved.groups,
    source: mongoGroup ? 'mongo+file' : 'file',
    message: resolved.match.exact
      ? `Found and added: ${matchedName}`
      : `Found close match and added: ${matchedName}`,
  };
}

/**
 * Remove group from Mongo (active=false) + file allow-list.
 */
export async function untrackGroupFromGui(name) {
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

  const fileCfg = loadJobsConfig();
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

  const saved = syncFileAllowList(next, { allowEmpty: true });
  return {
    ok: true,
    removed: true,
    group: mongoGroup,
    groups: saved.groups,
    message: `Removed: ${cleaned}`,
  };
}
