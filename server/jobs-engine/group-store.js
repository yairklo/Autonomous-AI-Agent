/**
 * Mongo TrackedGroup helpers for WhatsApp job ingest allow-list.
 */

import { TrackedGroup } from '../models/TrackedGroup.js';
import { loadJobsConfig, normalizeGroupNames } from '../jobs/jobs-config.js';
import { mongoReady } from './mongo-ready.js';

export { mongoReady };

function nameKey(name) {
  return String(name || '').trim().toLowerCase();
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
  const doc = await TrackedGroup.findOneAndUpdate(
    { $or: [{ groupId: id }, { name: new RegExp(`^${escapeRe(cleaned)}$`, 'i') }] },
    {
      $set: {
        groupId: id,
        name: cleaned,
        active: true,
        addedBy: String(addedBy || 'api'),
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

export async function isTrackedGroupName(name) {
  if (!mongoReady()) return false;
  const cleaned = String(name || '').trim();
  if (!cleaned) return false;
  const doc = await TrackedGroup.findOne({
    active: true,
    name: new RegExp(`^${escapeRe(cleaned)}$`, 'i'),
  })
    .select({ _id: 1 })
    .lean();
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
