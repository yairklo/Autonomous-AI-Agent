import { Message } from './models/Message.js';

/**
 * Logs a chat message to MongoDB.
 * @param {object} params
 * @param {string} params.sessionId
 * @param {string} params.userId
 * @param {string} [params.userName]
 * @param {string} params.channel
 * @param {string} params.role
 * @param {string} params.content
 */
export async function logMessage({ sessionId, userId, userName, channel, role, content }) {
  if (process.env.MONGO_URI) {
    try {
      const msg = new Message({
        sessionId,
        userId,
        userName,
        channel,
        role,
        content
      });
      await msg.save();
      return msg;
    } catch (err) {
      console.warn('[message-store] Error saving message to MongoDB:', err.message);
    }
  }
}

export async function getMessages({ userId, channel, sessionId, limit = 50 }) {
  if (!process.env.MONGO_URI) return [];
  const query = {};
  if (userId) query.userId = userId;
  if (channel) query.channel = channel;
  if (sessionId) query.sessionId = sessionId;
  
  try {
    return await Message.find(query)
      .sort({ createdAt: -1 })
      .limit(Number(limit))
      .exec();
  } catch (err) {
    console.warn('[message-store] Error fetching messages:', err.message);
    return [];
  }
}
