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

export function looksLikeChatJid(value) {
  const s = String(value || '');
  return isGroupLikeJid(s) || isDirectChatId(s);
}

/** Best-effort group title from a wwebjs message without calling getChat(). */
export function groupTitleFromMessage(msg = {}) {
  const candidates = [
    msg.groupName,
    msg.chat?.name,
    msg.chat?.formattedTitle,
    msg._data?.formattedTitle,
    msg._data?.chat?.formattedTitle,
    msg._data?.chat?.name,
  ];
  for (const raw of candidates) {
    const s = String(raw || '').trim();
    if (s && !looksLikeChatJid(s)) return s;
  }
  return '';
}

export function whatsappSelfUserId(client) {
  const w = client?.info?.wid;
  if (!w) return '';
  if (typeof w.user === 'string' && w.user.trim()) return w.user.trim();
  return String(w._serialized || '').replace(/@.*$/, '').trim();
}

export function chatUserPart(id) {
  return String(id || '')
    .replace(/@.*$/, '')
    .trim();
}

/** Old WhatsApp group JID owned by this account: `<ownNumber>-<unix>@g.us`. */
export function isOwnLegacyGroupJid(chatId, selfUser) {
  const me = chatUserPart(selfUser);
  if (!me) return false;
  const escaped = me.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}-\\d+@g\\.us$`).test(String(chatId || ''));
}

/**
 * Message yourself / "אני": labeled אני, own @c.us, or the owner's old-style
 * `@g.us` (`<ownNumber>-<timestamp>@g.us`) when getChat failed and only the JID remains.
 * Does not treat fromMe into someone else's group/DM as self-chat.
 */
export function isSelfChatTarget({
  fromMe,
  isGroup,
  chatId,
  groupName,
  selfUser,
} = {}) {
  const name = String(groupName || '').trim();
  if (name === SELF_CHAT_LABEL) return true;
  const id = String(chatId || '');
  const me = chatUserPart(selfUser);
  if (me && isDirectChatId(id) && chatUserPart(id) === me) return true;
  if (isOwnLegacyGroupJid(id, me)) return true;
  if (!fromMe) return false;
  if (me) return false;
  return isDirectChatId(id) || !isGroup;
}

export function resolveDisplayName({ isGroup, name, chatId, fromMe, selfUser } = {}) {
  if (
    isSelfChatTarget({
      fromMe,
      isGroup,
      chatId,
      groupName: name,
      selfUser,
    })
  ) {
    return SELF_CHAT_LABEL;
  }
  const cleaned = String(name || '').trim();
  if (cleaned && !looksLikeChatJid(cleaned)) return cleaned;
  if (cleaned && looksLikeChatJid(cleaned) && isGroup) {
    /* keep going — JID is not a display name */
  } else if (cleaned) {
    return cleaned;
  }
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
  if (hit.isGroup && !String(hit.name || '').trim()) {
    cache.delete(id);
    return null;
  }
  return hit;
}

export function setCachedChat(chatId, info) {
  const id = String(chatId || '');
  if (!id) return;
  const name = String(info?.name || '').trim();
  const isGroup = Boolean(info?.isGroup || isGroupLikeJid(id));
  if (isGroup && !name) return;
  cache.set(id, { isGroup, name, at: Date.now() });
}

export function seedChatCacheFromGroups(groups = []) {
  let n = 0;
  for (const g of Array.isArray(groups) ? groups : []) {
    const id = String(g?.id || '').trim();
    const name = String(g?.name || '').trim();
    if (!id || !name) continue;
    setCachedChat(id, { isGroup: true, name });
    n += 1;
  }
  return n;
}

export function clearChatCache() {
  cache.clear();
}

/**
 * Resolve group metadata with cache, then getChat / getChatById, then JID fallback.
 */
export async function resolveChatInfo(msg, client, onLog = () => {}) {
  const chatId = groupChatIdFromMessage(msg);
  const fromPayload = groupTitleFromMessage(msg);
  const cached = getCachedChat(chatId);
  if (cached?.name) return { ...cached, chatId };

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
  const name = String(
    chat?.name || chat?.formattedTitle || fromPayload || msg.groupName || ''
  ).trim();
  const info = { isGroup, name: looksLikeChatJid(name) ? '' : name, chatId };
  if (chatId) setCachedChat(chatId, info);
  return { ...info, name: info.name };
}
