/**
 * List joined WhatsApp group / community / newsletter chats from a live client.
 */

export function chatSerializedId(chat) {
  return String(chat?.id?._serialized || chat?.id || '');
}

export function isGroupLikeJid(id) {
  const s = String(id || '');
  return s.includes('@g.us') || s.includes('@newsletter');
}

export function isGroupLikeChat(chat) {
  const id = chatSerializedId(chat);
  return Boolean(chat?.isGroup) || isGroupLikeJid(id);
}

export function isReadOnlyChat(chat) {
  return Boolean(
    chat?.isReadOnly ||
      chat?.announce ||
      chat?.groupMetadata?.announce
  );
}

export function summarizeGroupChat(chat) {
  const id = chatSerializedId(chat);
  return {
    name: String(chat?.name || '').trim(),
    id,
    isGroup: isGroupLikeChat(chat),
    isReadOnly: isReadOnlyChat(chat),
    isNewsletter: id.includes('@newsletter'),
  };
}

/**
 * @param {object} client - whatsapp-web.js Client
 * @returns {Promise<{ name: string, id: string, isGroup: boolean, isReadOnly: boolean, isNewsletter: boolean }[]>}
 */
export async function listJoinedWhatsappGroups(client) {
  if (!client || typeof client.getChats !== 'function') {
    const err = new Error('WhatsApp client cannot list chats');
    err.code = 'WA_NO_GETCHATS';
    throw err;
  }
  const chats = await client.getChats();
  return (Array.isArray(chats) ? chats : [])
    .map(summarizeGroupChat)
    .filter((g) => g.isGroup)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}
