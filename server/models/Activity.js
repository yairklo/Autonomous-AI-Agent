import mongoose from 'mongoose';

const ActivitySchema = new mongoose.Schema({
  sessionId: { type: String, required: false, index: true },
  userId: { type: String, required: false, index: true },
  channel: { type: String, required: false },
  actionType: { type: String, required: true },
  details: { type: mongoose.Schema.Types.Mixed },
  status: { type: String, enum: ['pending', 'success', 'error', 'running', 'done'], default: 'pending' },
  error: { type: String },
  createdAt: { type: Date, default: Date.now, index: true }
});

ActivitySchema.index({ userId: 1, createdAt: -1 });
ActivitySchema.index({ sessionId: 1, createdAt: -1 });
ActivitySchema.index({ actionType: 'text' }); // We can't index Mixed easily for text, but this is a start

export const Activity = mongoose.model('Activity', ActivitySchema);
