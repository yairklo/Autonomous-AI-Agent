/**
 * Mongo TrackedGroup helpers for WhatsApp job ingest allow-list.
 */

import mongoose from 'mongoose';
import { TrackedGroup } from '../models/TrackedGroup.js';
import { loadJobsConfig, normalizeGroupNames } from '../jobs/jobs-config.js';
import { isGroupLikeJid } from '../whatsapp/groups.js';

export function mongoReady() {
  return mongoose.connection.readyState === 1;
}

function nameKey(name) {
  return String(name || '').trim().toLowerCase();
}

/**
 * Pair live WhatsApp chats to tracked groups by exact name (case-insensitive).
 * Ambiguous titles are skipped — never guess the JID.
 */
export function matchJoinedToTracked(joined = [], tracked = []) {
  const bound = [];
  const unbound = [];
  for (const g of tracked) {
    const key = nameKey(g.name);
    if (!key) continue;
    const hits = (Array.isArray(joined) ? joined : []).filter(
      (j) => nameKey(j.name) === key && isGroupLikeJid(j.id)
    );
    if (hits.length === 1) {
      bound.push({ name: g.name, jid: String(hits[0].id), trackedId: g._id });
    } else {
      unbound.push({ name: g.name, hits: hits.length });
    }
  }
  return { bound, unbound };
}

export async function bindTrackedGroupJids(joined) {
  if (!mongoReady()) {
    return { bound: 0, unbound: 0, reason: 'mongo_unavailable' };
  }
  const tracked = await listTrackedGroups({ activeOnly: true });
  const { bound, unbound } = matchJoinedToTracked(joined, tracked);
  for (const row of bound) {
    await TrackedGroup.findOneAndUpdate(
      { _id: row.trackedId },
      { $set: { jid: row.jid } }
    );
  }
  return { bound: bound.length, unbound: unbound.length, names: bound.map((b) => b.name) };
}

export function groupIdFromName(name) {
  return `name:${nameKey(name)}`;
}

export async function listTrackedGroups({ activeOnly = true } = {}) {
  if (!mongoReady()) {
    const err = new Error('MongoDB is not connected');
    err.code = 'MONGO_UNAVAILABLE';
    throw err;
  }
  const q = activeOnly ? { active: true } : {};
  return TrackedGroup.find(q).sort({ name: 1 }).lean();
}

export async function trackGroupByName(
  name,
  { addedBy = 'api', groupId } = {}
) {
  if (!mongoReady()) {
    const err = new Error('MongoDB is not connected');
    err.code = 'MONGO_UNAVAILABLE';
    throw err;
  }
  const cleaned = String(name || '').trim();
  if (!cleaned) {
    const err = new Error('group name required');
    err.code = 'GROUP_NAME_REQUIRED';
    throw err;
  }
  const id = groupId || groupIdFromName(cleaned);
  const jid = isGroupLikeJid(id) ? id : undefined;
  const doc = await TrackedGroup.findOneAndUpdate(
    { $or: [{ groupId: id }, { name: new RegExp(`^${escapeRe(cleaned)}$`, 'i') }] },
    {
      $set: {
        groupId: id,
        name: cleaned,
        active: true,
        addedBy: String(addedBy || 'api'),
        ...(jid ? { jid } : {}),
      },
      $setOnInsert: { addedAt: new Date() },
    },
    { upsert: true, returnDocument: 'after' }
  ).lean();
  return doc;
}

export async function untrackGroupByName(name) {
  if (!mongoReady()) {
    const err = new Error('MongoDB is not connected');
    err.code = 'MONGO_UNAVAILABLE';
    throw err;
  }
  const cleaned = String(name || '').trim();
  if (!cleaned) {
    const err = new Error('group name required');
    err.code = 'GROUP_NAME_REQUIRED';
    throw err;
  }
  const doc = await TrackedGroup.findOneAndUpdate(
    { name: new RegExp(`^${escapeRe(cleaned)}$`, 'i') },
    { $set: { active: false } },
    { returnDocument: 'after' }
  ).lean();
  return doc;
}

export async function isTrackedChat({ name, chatId } = {}) {
  if (!mongoReady()) return false;
  const or = [];
  const cleaned = String(name || '').trim();
  const id = String(chatId || '').trim();
  if (cleaned) {
    or.push({ name: new RegExp(`^${escapeRe(cleaned)}$`, 'i') });
    if (isGroupLikeJid(cleaned)) {
      or.push({ groupId: cleaned }, { jid: cleaned });
    }
  }
  if (id && isGroupLikeJid(id)) {
    or.push({ groupId: id }, { jid: id });
  }
  if (!or.length) return false;
  const doc = await TrackedGroup.findOne({ active: true, $or: or })
    .select({ _id: 1 })
    .lean();
  return Boolean(doc);
}

export async function isTrackedGroupName(name) {
  return isTrackedChat({ name, chatId: name });
}

export async function rememberTrackedGroupJid(name, chatId) {
  if (!mongoReady()) return false;
  const cleaned = String(name || '').trim();
  const jid = String(chatId || '').trim();
  if (!cleaned || !isGroupLikeJid(jid)) return false;
  const doc = await TrackedGroup.findOneAndUpdate(
    { active: true, name: new RegExp(`^${escapeRe(cleaned)}$`, 'i') },
    { $set: { jid } },
    { returnDocument: 'after' }
  ).lean();
  return Boolean(doc);
}

/**
 * Seed TrackedGroup from config.json / override when collection is empty.
 * @returns {{ seeded: boolean, count: number, names: string[] }}
 */
export async function seedTrackedGroupsFromConfig(jobsConfig) {
  if (!mongoReady()) {
    return { seeded: false, count: 0, names: [], reason: 'mongo_unavailable' };
  }
  const existing = await TrackedGroup.countDocuments();
  if (existing > 0) {
    return { seeded: false, count: existing, names: [] };
  }
  const names = normalizeGroupNames(jobsConfig?.whatsapp?.groups || []);
  for (const name of names) {
    await TrackedGroup.create({
      groupId: groupIdFromName(name),
      name,
      active: true,
      addedBy: 'config-seed',
      addedAt: new Date(),
    });
  }
  return { seeded: true, count: names.length, names };
}

export async function ensureTrackedGroupsSeeded() {
  const jobsConfig = loadJobsConfig();
  return seedTrackedGroupsFromConfig(jobsConfig);
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
