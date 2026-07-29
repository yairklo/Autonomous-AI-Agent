import mongoose from 'mongoose';

export const JOB_STATUSES = [
  'discovered',
  'parsing',
  'ready_to_apply',
  'applied',
  'requires_human',
  'failed',
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
    fingerprint: { type: String, default: '', index: true },
    rawText: { type: String, default: '' },
  },
  { timestamps: true }
);

JobSchema.index({ status: 1, updatedAt: -1 });
JobSchema.index({ fingerprint: 1, source: 1 });

export const Job =
  mongoose.models.Job || mongoose.model('Job', JobSchema);
