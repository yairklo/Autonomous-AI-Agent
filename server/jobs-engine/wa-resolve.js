/**
 * Resolve WhatsApp group chats from the live shared session (listen-only).
 */

import { getSharedWhatsappSession } from '../whatsapp/session.js';

/**
 * @param {string} name
 * @param {object} [opts]
 * @param {object} [opts.session]
 * @param {object[]} [opts.chats] - injected for tests
 * @returns {Promise<{
 *   ok: boolean,
 *   found: boolean,
 *   waState: string,
 *   match?: { id: string, name: string, exact: boolean },
 *   suggestions?: { id: string, name: string }[],
 *   error?: string,
 *   code?: string
 * }>}
 */
export async function resolveWhatsappGroupByName(name, opts = {}) {
  const cleaned = String(name || '').trim();
  if (!cleaned) {
    return {
      ok: false,
      found: false,
      waState: 'unknown',
      error: 'Group name required',
      code: 'GROUP_NAME_REQUIRED',
    };
  }

  const session = opts.session || getSharedWhatsappSession();
  const waState = session.getState?.() || 'uninitialized';
  const client = session.getClient?.() || null;

  if (!opts.chats && (!client || waState !== 'authenticated')) {
    return {
      ok: false,
      found: false,
      waState,
      error:
        'WhatsApp is not connected. Open Settings after POST /api/whatsapp/start and QR scan.',
      code: 'WA_NOT_READY',
    };
  }

  let chats = opts.chats;
  if (!chats) {
    try {
      const { listJoinedWhatsappGroups } = await import('../whatsapp/groups.js');
      chats = await listJoinedWhatsappGroups(client);
    } catch (err) {
      return {
        ok: false,
        found: false,
        waState,
        error: `Failed to list chats: ${err.message}`,
        code: 'WA_GETCHATS_FAILED',
      };
    }
  }

  const groups = (Array.isArray(chats) ? chats : [])
    .filter((c) => c && (c.isGroup || c.id || c.id?._serialized))
    .map((c) => ({
      id: String(c.id?._serialized || c.id || ''),
      name: String(c.name || '').trim(),
    }))
    .filter((c) => c.name && (c.id.includes('@g.us') || c.id.includes('@newsletter') || c.isGroup !== false));

  const needle = cleaned.toLowerCase();
  const exact = groups.find((g) => g.name.toLowerCase() === needle);
  if (exact) {
    return {
      ok: true,
      found: true,
      waState,
      match: { id: exact.id, name: exact.name, exact: true },
    };
  }

  const partial = groups.filter((g) => g.name.toLowerCase().includes(needle));
  if (partial.length === 1) {
    return {
      ok: true,
      found: true,
      waState,
      match: { id: partial[0].id, name: partial[0].name, exact: false },
    };
  }

  return {
    ok: true,
    found: false,
    waState,
    suggestions: partial.slice(0, 8),
    error:
      partial.length > 1
        ? `Multiple groups match "${cleaned}" — pick a more exact name`
        : `No WhatsApp group found matching "${cleaned}"`,
    code: partial.length > 1 ? 'WA_GROUP_AMBIGUOUS' : 'WA_GROUP_NOT_FOUND',
  };
}
