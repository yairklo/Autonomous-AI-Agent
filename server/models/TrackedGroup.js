import mongoose from 'mongoose';

const TrackedGroupSchema = new mongoose.Schema(
  {
    groupId: { type: String, required: true, unique: true, index: true },
    name: { type: String, default: '', index: true },
    /** Live WhatsApp JID (`…@g.us`) when known — ingest often only has this. */
    jid: { type: String, default: '', index: true },
    active: { type: Boolean, default: true, index: true },
    addedBy: { type: String, default: '' },
    addedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

TrackedGroupSchema.index({ active: 1, name: 1 });

export const TrackedGroup =
  mongoose.models.TrackedGroup ||
  mongoose.model('TrackedGroup', TrackedGroupSchema);
