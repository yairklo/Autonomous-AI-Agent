import mongoose from 'mongoose';

const MessageSchema = new mongoose.Schema({
  sessionId: { type: String, required: true, index: true },
  userId: { type: String, required: true, index: true },
  userName: { type: String, required: false },
  channel: { type: String, required: true, enum: ['telegram', 'web-ui', 'voice'], index: true },
  role: { type: String, required: true, enum: ['user', 'assistant', 'system'] },
  content: { type: String, required: true },
  createdAt: { type: Date, default: Date.now, index: true }
});

MessageSchema.index({ userId: 1, createdAt: -1 });
MessageSchema.index({ sessionId: 1, createdAt: -1 });
MessageSchema.index({ content: 'text' });

export const Message = mongoose.model('Message', MessageSchema);
