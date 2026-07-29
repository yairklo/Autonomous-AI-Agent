/**
 * Mongo Job upsert helpers for WhatsApp ingest (status: discovered).
 */

import mongoose from 'mongoose';
import { Job } from '../models/Job.js';
import { JobDb } from '../jobs/job-db.js';

export function mongoReady() {
  return mongoose.connection.readyState === 1;
}

export function fingerprintFromMatchedJob(job) {
  return JobDb.fingerprint({
    text: job.text || job.body || job.rawText || '',
    groupName: job.groupName || '',
    author: job.author || '',
    formUrl: job.formUrl || job.contacts?.urls?.[0] || job.applyUrl || '',
  });
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
      groupName: groupName || matched.groupName,
      applyUrl,
    });

  const existing = await Job.findOne({ fingerprint }).lean();
  if (existing) {
    return { job: existing, isNew: false, duplicateOf: existing.jobId };
  }

  const jobId = fingerprint;
  const title =
    String(matched.title || '').trim() ||
    rawText.split('\n').map((l) => l.trim()).find(Boolean)?.slice(0, 120) ||
    'WhatsApp job';

  const doc = await Job.create({
    jobId,
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
