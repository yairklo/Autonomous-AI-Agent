/**
 * Distinct WhatsApp chats that actually stored raw messages.
 */

import { WhatsappMessage } from '../models/WhatsappMessage.js';
import { mongoReady } from './job-store.js';

/**
 * @param {{ since?: string|Date }} [opts]
 * @returns {Promise<{ chatId: string, chatName: string, count: number, lastAt: Date }[]>}
 */
export async function listCapturedChatStats({ since } = {}) {
  if (!mongoReady()) {
    const err = new Error('MongoDB is not connected');
    err.code = 'MONGO_UNAVAILABLE';
    throw err;
  }
  const match = {};
  if (since) {
    const d = since instanceof Date ? since : new Date(since);
    if (!Number.isNaN(d.getTime())) match.timestamp = { $gte: d };
  }
  const rows = await WhatsappMessage.aggregate([
    ...(Object.keys(match).length ? [{ $match: match }] : []),
    {
      $group: {
        _id: '$chatId',
        chatName: { $last: '$chatName' },
        count: { $sum: 1 },
        lastAt: { $max: '$timestamp' },
      },
    },
    { $sort: { count: -1 } },
  ]);
  return rows.map((r) => ({
    chatId: r._id,
    chatName: r.chatName || '',
    count: r.count,
    lastAt: r.lastAt,
  }));
}
