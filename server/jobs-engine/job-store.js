/**
 * Mongo Job + raw WhatsApp message upsert helpers.
 */

import { Job } from '../models/Job.js';
import { WhatsappMessage } from '../models/WhatsappMessage.js';
import { JobDb, openJobDb } from '../jobs/job-db.js';
import { loadJobsConfig } from '../jobs/jobs-config.js';
import { mongoReady } from './mongo-ready.js';

export { mongoReady };

export function fingerprintFromMatchedJob(job) {
  return JobDb.fingerprint({
    text: job.text || job.body || job.rawText || '',
    author: job.author || '',
    formUrl: job.formUrl || job.contacts?.urls?.[0] || job.applyUrl || '',
  });
}

export function waMessageIdFromMsg(msg = {}) {
  if (msg.messageId) return String(msg.messageId);
  const id = msg.id;
  if (id && typeof id === 'object') {
    return String(id._serialized || id.id || '');
  }
  return String(id || '');
}

/**
 * Insert raw WA message. Duplicate (chatId+messageId) returns isNew: false.
 * @returns {Promise<{ stored: boolean, isNew: boolean, reason?: string }>}
 */
export async function persistRawWhatsappMessage(doc) {
  if (!mongoReady()) {
    return { stored: false, isNew: false, reason: 'mongo_unavailable' };
  }
  const messageId = String(doc.messageId || '').trim();
  const chatId = String(doc.chatId || '').trim();
  if (!messageId || !chatId) {
    return { stored: false, isNew: true, reason: 'missing_id' };
  }
  try {
    await WhatsappMessage.create({
      messageId,
      chatId,
      chatName: doc.chatName || '',
      fromMe: Boolean(doc.fromMe),
      timestamp: doc.timestamp ? new Date(doc.timestamp) : new Date(),
      type: doc.type || 'chat',
      body: doc.body || '',
      hasMedia: Boolean(doc.hasMedia),
      author: doc.author || '',
      raw: doc.raw || {},
    });
    return { stored: true, isNew: true };
  } catch (err) {
    if (err?.code === 11000) {
      return { stored: true, isNew: false };
    }
    throw err;
  }
}

export async function updateWhatsappChatName(chatId, chatName) {
  if (!mongoReady()) return 0;
  const id = String(chatId || '').trim();
  const name = String(chatName || '').trim();
  if (!id || !name) return 0;
  const res = await WhatsappMessage.updateMany({ chatId: id }, { $set: { chatName: name } });
  return Number(res?.modifiedCount || 0);
}

export async function listJidLabeledMessages({ limit = 80 } = {}) {
  if (!mongoReady()) return [];
  const lim = Math.min(Math.max(Number(limit) || 80, 1), 200);
  const rows = await WhatsappMessage.find({ chatId: /@g\.us$|@newsletter$/i })
    .sort({ timestamp: -1 })
    .limit(lim * 2)
    .select({ raw: 0 })
    .lean();
  return rows
    .filter((r) => {
      const name = String(r.chatName || '').trim();
      const id = String(r.chatId || '').trim();
      return !name || name === id || /@(g\.us|c\.us|newsletter)$/i.test(name);
    })
    .slice(0, lim);
}

/**
 * Insert a discovered job or return existing duplicate without regressing status.
 * @returns {Promise<{ job: object, isNew: boolean, duplicateOf?: string }>}
 */
export async function upsertDiscoveredJob(
  matched,
  { groupId = '', groupName = '' } = {}
) {
  if (!mongoReady()) {
    const err = new Error('MongoDB is not connected');
    err.code = 'MONGO_UNAVAILABLE';
    throw err;
  }

  const rawText = String(matched.text || matched.body || matched.rawText || '').trim();
  const applyUrl =
    matched.applyUrl ||
    matched.formUrl ||
    matched.contacts?.urls?.[0] ||
    '';
  const fingerprint =
    matched.fingerprint ||
    fingerprintFromMatchedJob({
      ...matched,
      text: rawText,
      applyUrl,
    });

  const title =
    String(matched.title || '').trim() ||
    rawText.split('\n').map((l) => l.trim()).find(Boolean)?.slice(0, 120) ||
    'WhatsApp job';

  try {
    const existing = await Job.findOne({ fingerprint });
    if (existing) {
      const seen = existing.parsedData?.seenInGroups || [];
      if (groupName && !seen.includes(groupName)) {
        existing.parsedData = {
          ...(existing.parsedData || {}),
          seenInGroups: [...seen, groupName],
        };
        existing.markModified('parsedData');
        await existing.save();
      }
      return {
        job: existing.toObject(),
        isNew: false,
        duplicateOf: existing.jobId,
      };
    }

    const doc = await Job.create({
      jobId: fingerprint,
      source: 'whatsapp_group',
      groupId: groupId || '',
      title,
      company: String(matched.company || '').trim(),
      description: rawText.slice(0, 4000),
      applyUrl,
      status: 'discovered',
      fingerprint,
      rawText,
      parsedData: {
        score: matched.score ?? null,
        rolesMatched: matched.rolesMatched || [],
        matchedSignals: matched.matchedSignals || [],
        contacts: matched.contacts || {},
        groupName: groupName || matched.groupName || '',
        author: matched.author || '',
        seenInGroups: groupName ? [groupName] : [],
      },
      applicationLog: [
        {
          at: new Date(),
          action: 'discovered',
          ok: true,
          detail: `Ingested from WhatsApp group ${groupName || groupId || 'unknown'}`,
        },
      ],
    });

    return { job: doc.toObject(), isNew: true };
  } catch (err) {
    if (err?.code === 11000) {
      const dup = await Job.findOne({ fingerprint }).lean();
      if (dup) return { job: dup, isNew: false, duplicateOf: dup.jobId };
    }
    throw err;
  }
}

/**
 * Mirror a JobDb (approval/submission) status transition onto the Mongo Job
 * record with the same fingerprint, so /api/jobs/recent reflects reality
 * instead of staying stuck at 'discovered' forever. Best-effort: swallows
 * errors (Mongo down, no matching doc) and reports via the return value
 * rather than throwing, since this is a secondary observability mirror, not
 * the source of truth (the JSON JobDb is).
 * @returns {Promise<{ synced: boolean, error?: string }>}
 */
export async function syncMongoJobStatus(fingerprint, status, detail = {}) {
  if (!fingerprint || !mongoReady()) {
    return { synced: false, error: !fingerprint ? 'missing_fingerprint' : 'mongo_unavailable' };
  }
  try {
    const doc = await Job.findOneAndUpdate(
      { fingerprint },
      {
        $set: { status },
        $push: {
          applicationLog: {
            at: new Date(),
            action: status,
            ok: detail.ok !== false,
            detail: String(detail.message || '').slice(0, 500),
            screenshotPath: detail.screenshotPath || '',
          },
        },
      },
      { new: true }
    ).lean();
    return { synced: Boolean(doc) };
  } catch (err) {
    return { synced: false, error: err.message };
  }
}

export async function listRecentJobs({ limit = 50, status } = {}) {
  if (!mongoReady()) {
    const err = new Error('MongoDB is not connected');
    err.code = 'MONGO_UNAVAILABLE';
    throw err;
  }
  const q = {};
  if (status) q.status = String(status);
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  return Job.find(q).sort({ updatedAt: -1 }).limit(lim).lean();
}

function firstLine(text) {
  return (
    String(text || '')
      .split(/\n/)
      .map((s) => s.trim())
      .find(Boolean) || ''
  );
}

function normalizeStatus(status) {
  const s = String(status || '').trim();
  if (s === 'detected') return 'discovered';
  return s || 'discovered';
}

function jobDbToRow(j) {
  const title = firstLine(j.text) || (j.rolesMatched || []).join(' / ') || 'Untitled job';
  return {
    id: j.id,
    fingerprint: j.fingerprint || j.id,
    title: title.slice(0, 120),
    company: j.company || '',
    group: j.groupName || '',
    applyUrl: j.formUrl || j.contacts?.urls?.[0] || j.submitResult?.formUrl || '',
    status: normalizeStatus(j.status),
    approvalStatus: j.approvalStatus || '',
    submittedAt: j.submittedAt || '',
    createdAt: j.createdAt || '',
    updatedAt: j.updatedAt || j.createdAt || '',
    source: j.source || 'jobdb',
  };
}

function mongoToRow(j, local) {
  const parsed = j.parsedData || {};
  const applyUrl =
    j.applyUrl || local?.applyUrl || parsed.contacts?.urls?.[0] || '';
  const title =
    j.title ||
    local?.title ||
    (parsed.rolesMatched || []).join(' / ') ||
    firstLine(j.rawText || j.description) ||
    'Untitled job';
  return {
    id: j.jobId || local?.id || j.fingerprint,
    fingerprint: j.fingerprint || local?.fingerprint || '',
    title: String(title).slice(0, 120),
    company: j.company || local?.company || '',
    group: parsed.groupName || local?.group || '',
    applyUrl,
    status: normalizeStatus(j.status || local?.status),
    approvalStatus: local?.approvalStatus || '',
    submittedAt: local?.submittedAt || '',
    createdAt: j.createdAt || local?.createdAt || '',
    updatedAt: j.updatedAt || local?.updatedAt || '',
    source: j.source || local?.source || 'mongo',
  };
}

/**
 * GUI jobs table: JSON JobDb (approval/submit) merged with Mongo (ingest).
 * Works when Mongo is down — JobDb on the data volume is enough.
 */
export async function listJobsForGui({ limit = 80, status } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 80, 1), 200);
  let local = [];
  let source = 'jobdb';
  try {
    const jobsConfig = loadJobsConfig();
    const db = openJobDb(jobsConfig.storage.jobsDbPath);
    local = db.list({ limit: 500 });
  } catch {
    local = [];
  }

  let mongoJobs = [];
  if (mongoReady()) {
    try {
      mongoJobs = await listRecentJobs({ limit: 200 });
      source = local.length ? 'mongo+jobdb' : 'mongo';
    } catch {
      source = local.length ? 'jobdb' : 'none';
    }
  }

  const byKey = new Map();
  for (const j of local) {
    const row = jobDbToRow(j);
    byKey.set(row.fingerprint || row.id, row);
  }
  for (const j of mongoJobs) {
    const fp = j.fingerprint || j.jobId;
    const existing = byKey.get(fp);
    byKey.set(fp, mongoToRow(j, existing));
  }

  let rows = [...byKey.values()];
  if (status) {
    const s = String(status).toLowerCase();
    rows = rows.filter(
      (r) =>
        String(r.status).toLowerCase() === s ||
        String(r.approvalStatus).toLowerCase() === s
    );
  }
  rows.sort((a, b) =>
    String(b.updatedAt || b.createdAt || '').localeCompare(
      String(a.updatedAt || a.createdAt || '')
    )
  );
  return {
    jobs: rows.slice(0, lim),
    source,
    mongo: mongoReady(),
    total: rows.length,
  };
}

export async function listRecentWhatsappMessages({
  limit = 50,
  chatId,
  since,
} = {}) {
  if (!mongoReady()) {
    const err = new Error('MongoDB is not connected');
    err.code = 'MONGO_UNAVAILABLE';
    throw err;
  }
  const q = {};
  if (chatId) q.chatId = String(chatId);
  if (since) {
    const d = since instanceof Date ? since : new Date(since);
    if (!Number.isNaN(d.getTime())) q.timestamp = { $gte: d };
  }
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  return WhatsappMessage.find(q)
    .sort({ timestamp: -1 })
    .limit(lim)
    .select({ raw: 0 })
    .lean();
}
