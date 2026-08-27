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

function normalizeListedGroups(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .filter((g) => g && isGroupLikeJid(g.id) && String(g.name || '').trim())
    .map((g) => ({
      name: String(g.name).trim(),
      id: String(g.id),
      isGroup: true,
      isReadOnly: Boolean(g.isReadOnly),
      isNewsletter: String(g.id).includes('@newsletter'),
    }))
    .sort((a, b) => {
      try {
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      } catch {
        return String(a.name).localeCompare(String(b.name));
      }
    });
}

/**
 * Read group id→title from the in-page WhatsApp Store.
 * wwebjs `getChats()` / `getChat()` often throw minified `"r"` even when a
 * message just arrived and Store.Chat already has that JID.
 */
export async function listGroupsFromStore(client) {
  const page = client?.pupPage;
  if (!page || typeof page.evaluate !== 'function') return [];
  try {
    const rows = await page.evaluate(() => {
      const out = [];
      const seen = {};
      const pushChat = (chat) => {
        if (!chat) return;
        const id = String(chat.id?._serialized || '');
        if (!id || seen[id]) return;
        if (id.indexOf('@g.us') < 0 && id.indexOf('@newsletter') < 0) return;
        const name = String(chat.name || chat.formattedTitle || '').trim();
        if (!name) return;
        seen[id] = true;
        out.push({
          id,
          name,
          isReadOnly: Boolean(chat.announce || chat.isReadOnly),
        });
      };
      try {
        const arr = window.Store?.Chat?.getModelsArray?.() || [];
        for (let i = 0; i < arr.length; i += 1) pushChat(arr[i]);
      } catch (_e) {
        /* listing all models can throw the same minified "r" as getChats */
      }
      return out;
    });
    return normalizeListedGroups(rows);
  } catch {
    return [];
  }
}

export async function readChatTitleFromStore(client, chatId) {
  const id = String(chatId || '').trim();
  const page = client?.pupPage;
  if (!id || !page || typeof page.evaluate !== 'function') return '';
  try {
    const title = await page.evaluate((serial) => {
      const pick = (chat) =>
        String(chat?.name || chat?.formattedTitle || chat?.contact?.name || '').trim();
      try {
        const direct = window.Store?.Chat?.get?.(serial);
        const n = pick(direct);
        if (n) return n;
      } catch (_e) {
        /* ignore */
      }
      try {
        const wid = window.Store?.WidFactory?.createWid?.(serial);
        if (wid) {
          const n = pick(window.Store?.Chat?.get?.(wid));
          if (n) return n;
        }
      } catch (_e) {
        /* ignore */
      }
      try {
        const arr = window.Store?.Chat?.getModelsArray?.() || [];
        for (let i = 0; i < arr.length; i += 1) {
          const chat = arr[i];
          if (String(chat?.id?._serialized || '') === serial) {
            const n = pick(chat);
            if (n) return n;
          }
        }
      } catch (_e) {
        /* ignore */
      }
      return '';
    }, id);
    return String(title || '').trim();
  } catch {
    return '';
  }
}

/**
 * @param {object} client - whatsapp-web.js Client
 * @returns {Promise<{ name: string, id: string, isGroup: boolean, isReadOnly: boolean, isNewsletter: boolean }[]>}
 */
export async function listJoinedWhatsappGroups(client) {
  if (!client) {
    const err = new Error('WhatsApp client cannot list chats');
    err.code = 'WA_NO_GETCHATS';
    throw err;
  }
  if (typeof client.getChats === 'function') {
    try {
      const chats = await client.getChats();
      const listed = (Array.isArray(chats) ? chats : [])
        .map(summarizeGroupChat)
        .filter((g) => g.isGroup && g.name);
      if (listed.length) return normalizeListedGroups(listed);
    } catch {
      /* Store fallback below */
    }
  }
  const fromStore = await listGroupsFromStore(client);
  if (fromStore.length) return fromStore;
  if (typeof client.getChats !== 'function') {
    const err = new Error('WhatsApp client cannot list chats');
    err.code = 'WA_NO_GETCHATS';
    throw err;
  }
  const err = new Error('r');
  err.code = 'WA_GETCHATS_FAILED';
  throw err;
}
