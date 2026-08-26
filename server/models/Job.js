import mongoose from 'mongoose';

// Mirrors the local JobDb status vocabulary (server/jobs/job-db.js) so a
// job's Mongo record and its JSON approval/submission record never disagree.
// jobs-engine/job-store.js:syncMongoJobStatus keeps this field current as the
// job moves through Telegram approval and Playwright submission.
export const JOB_STATUSES = [
  'discovered',
  'awaiting_approval',
  'approved',
  'rejected',
  'submitted',
  'requires_manual_action',
  'submit_failed',
  'dry_run_submitted',
];

export const JOB_SOURCES = ['whatsapp_group', 'direct_link', 'manual'];

const ApplicationLogSchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    action: { type: String, required: true },
    ok: { type: Boolean, default: false },
    detail: { type: String, default: '' },
    screenshotPath: { type: String, default: '' },
  },
  { _id: false }
);

const JobSchema = new mongoose.Schema(
  {
    jobId: { type: String, required: true, unique: true, index: true },
    source: {
      type: String,
      enum: JOB_SOURCES,
      default: 'whatsapp_group',
      index: true,
    },
    groupId: { type: String, default: '', index: true },
    title: { type: String, default: '' },
    company: { type: String, default: '' },
    description: { type: String, default: '' },
    applyUrl: { type: String, default: '' },
    status: {
      type: String,
      enum: JOB_STATUSES,
      default: 'discovered',
      index: true,
    },
    parsedData: { type: mongoose.Schema.Types.Mixed, default: {} },
    applicationLog: { type: [ApplicationLogSchema], default: [] },
    fingerprint: { type: String, default: '', unique: true, sparse: true, index: true },
    rawText: { type: String, default: '' },
  },
  { timestamps: true }
);

JobSchema.index({ status: 1, updatedAt: -1 });

export const Job =
  mongoose.models.Job || mongoose.model('Job', JobSchema);
