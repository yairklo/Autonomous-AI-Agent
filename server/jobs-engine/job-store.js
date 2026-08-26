/**
 * Mongo Job + raw WhatsApp message upsert helpers.
 */

import mongoose from 'mongoose';
import { Job } from '../models/Job.js';
import { WhatsappMessage } from '../models/WhatsappMessage.js';
import { JobDb } from '../jobs/job-db.js';

export function mongoReady() {
  return mongoose.connection.readyState === 1;
}

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
