import mongoose from 'mongoose';

const WhatsappMessageSchema = new mongoose.Schema(
  {
    messageId: { type: String, required: true },
    chatId: { type: String, required: true, index: true },
    chatName: { type: String, default: '' },
    fromMe: { type: Boolean, default: false, index: true },
    timestamp: { type: Date, default: Date.now, index: true },
    type: { type: String, default: 'chat' },
    body: { type: String, default: '' },
    hasMedia: { type: Boolean, default: false },
    author: { type: String, default: '' },
    raw: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

WhatsappMessageSchema.index({ chatId: 1, messageId: 1 }, { unique: true });
WhatsappMessageSchema.index({ chatId: 1, timestamp: -1 });

export const WhatsappMessage =
  mongoose.models.WhatsappMessage ||
  mongoose.model('WhatsappMessage', WhatsappMessageSchema);
