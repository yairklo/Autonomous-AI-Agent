import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/**
 * Local-only JSON job DB for dedupe + approval/submit audit.
 * Never syncs remotely.
 */
export class JobDb {
  /**
   * @param {string} dbPath
   */
  constructor(dbPath) {
    this.dbPath = path.resolve(dbPath);
    this._data = { version: 1, jobs: {}, updatedAt: null };
    this._load();
  }

  _load() {
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    if (!fs.existsSync(this.dbPath)) {
      this._persist();
      return;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.dbPath, 'utf8'));
      this._data = {
        version: 1,
        jobs: parsed.jobs && typeof parsed.jobs === 'object' ? parsed.jobs : {},
        updatedAt: parsed.updatedAt || null,
      };
    } catch {
      this._data = { version: 1, jobs: {}, updatedAt: null };
      this._persist();
    }
  }

  _persist() {
    this._data.updatedAt = new Date().toISOString();
    fs.writeFileSync(this.dbPath, JSON.stringify(this._data, null, 2), 'utf8');
  }

  /**
   * Stable fingerprint for dedupe across groups / near-identical text.
   */
  static fingerprint({ text = '', groupName = '', author = '', formUrl = '' } = {}) {
    const normalized = String(text || '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/[^\p{L}\p{N}@./:\- ]+/gu, '')
      .trim()
      .slice(0, 800);
    const key = [groupName, author, formUrl, normalized].join('|');
    return createHash('sha256').update(key).digest('hex').slice(0, 32);
  }

  get(id) {
    return this._data.jobs[id] || null;
  }

  findByFingerprint(fp) {
    return Object.values(this._data.jobs).find((j) => j.fingerprint === fp) || null;
  }

  /**
   * Insert or return existing duplicate.
   * @returns {{ job: object, isNew: boolean, duplicateOf?: string }}
   */
  upsertJob(job) {
    const fingerprint =
      job.fingerprint ||
      JobDb.fingerprint({
        text: job.text,
        groupName: job.groupName,
        author: job.author,
        formUrl: job.formUrl || job.contacts?.urls?.[0] || '',
      });

    const existing = this.findByFingerprint(fingerprint);
    if (existing) {
      return { job: existing, isNew: false, duplicateOf: existing.id };
    }

    const id = job.id || fingerprint;
    const record = {
      id,
      fingerprint,
      status: job.status || 'detected',
      groupName: job.groupName || null,
      author: job.author || null,
      text: job.text || '',
      snippet: (job.text || '').slice(0, 280),
      rolesMatched: job.rolesMatched || [],
      contacts: job.contacts || { emails: [], phones: [], urls: [] },
      formUrl: job.formUrl || job.contacts?.urls?.[0] || null,
      telegramApprovalId: job.telegramApprovalId || null,
      approvalStatus: job.approvalStatus || 'pending',
      submittedAt: job.submittedAt || null,
      submitResult: job.submitResult || null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      source: job.source || 'whatsapp',
    };
    this._data.jobs[id] = record;
    this._persist();
    return { job: record, isNew: true };
  }

  update(id, patch) {
    const cur = this._data.jobs[id];
    if (!cur) {
      const err = new Error(`Job not found in local DB: ${id}`);
      err.code = 'JOB_NOT_FOUND';
      throw err;
    }
    const next = {
      ...cur,
      ...patch,
      id: cur.id,
      fingerprint: cur.fingerprint,
      updatedAt: new Date().toISOString(),
    };
    this._data.jobs[id] = next;
    this._persist();
    return next;
  }

  list({ status, limit = 100 } = {}) {
    let jobs = Object.values(this._data.jobs);
    if (status) jobs = jobs.filter((j) => j.status === status);
    jobs.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    return jobs.slice(0, Math.max(1, Math.min(Number(limit) || 100, 500)));
  }

  /**
   * True only when Telegram approval was recorded as approved.
   */
  isApproved(id) {
    const job = this.get(id);
    return Boolean(job && job.approvalStatus === 'approved');
  }
}

export function openJobDb(dbPath) {
  return new JobDb(dbPath);
}
