/**
 * chatId → { isGroup, name } cache so ingest does not call getChat() on every event.
 */

import { isGroupLikeJid } from '../whatsapp/groups.js';

const TTL_MS = 30 * 60 * 1000;
const cache = new Map();

/** Fallback display name for 1:1 "Message yourself" chats with no push name. */
export const SELF_CHAT_LABEL = 'אני';

export function isDirectChatId(id) {
  const s = String(id || '');
  if (isGroupLikeJid(s)) return false;
  return (
    s.includes('@c.us') ||
    s.includes('@lid') ||
    s.includes('@s.whatsapp.net')
  );
}

export function resolveDisplayName({ isGroup, name, chatId, fromMe } = {}) {
  const cleaned = String(name || '').trim();
  if (cleaned) return cleaned;
  if (!isGroup && fromMe) return SELF_CHAT_LABEL;
  return String(chatId || '').trim();
}

export function groupChatIdFromMessage(msg = {}) {
  const candidates = [msg.chatId, msg.from, msg.to];
  for (const c of candidates) {
    if (isGroupLikeJid(c)) return String(c);
  }
  return String(msg.from || msg.chatId || '');
}

export function getCachedChat(chatId) {
  const id = String(chatId || '');
  if (!id) return null;
  const hit = cache.get(id);
  if (!hit) return null;
  if (Date.now() - hit.at > TTL_MS) {
    cache.delete(id);
    return null;
  }
  return hit;
}

export function setCachedChat(chatId, info) {
  const id = String(chatId || '');
  if (!id) return;
  cache.set(id, {
    isGroup: Boolean(info?.isGroup || isGroupLikeJid(id)),
    name: String(info?.name || ''),
    at: Date.now(),
  });
}

export function clearChatCache() {
  cache.clear();
}

/**
 * Resolve group metadata with cache, then getChat / getChatById, then JID fallback.
 */
export async function resolveChatInfo(msg, client, onLog = () => {}) {
  const chatId = groupChatIdFromMessage(msg);
  const cached = getCachedChat(chatId);
  if (cached) return { ...cached, chatId };

  let chat = msg.chat || null;
  if (!chat && typeof msg.getChat === 'function') {
    try {
      chat = await msg.getChat();
    } catch (err) {
      onLog(`[whatsapp-ingest] getChat failed (${err.message})`);
    }
  }
  if (!chat && client && typeof client.getChatById === 'function' && chatId) {
    try {
      chat = await client.getChatById(chatId);
    } catch (err) {
      onLog(`[whatsapp-ingest] getChatById failed (${err.message})`);
    }
  }

  const isGroup = Boolean(chat?.isGroup || isGroupLikeJid(chatId));
  const name = String(chat?.name || msg.groupName || '').trim();
  const info = { isGroup, name, chatId };
  if (chatId) setCachedChat(chatId, info);
  return info;
}
