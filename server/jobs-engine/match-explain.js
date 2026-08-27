/**
 * Explain why a captured WhatsApp message did or did not become a Job.
 * Seeing a message in the GUI only means persistRaw ran — matching can still skip.
 */

import { isAllowedGroup, loadJobsConfig } from '../jobs/jobs-config.js';
import { matchFullStackOrBackend } from '../jobs/job-matcher.js';
import { isGroupLikeJid } from '../whatsapp/groups.js';
import { isSelfChatTarget, looksLikeChatJid, SELF_CHAT_LABEL } from './chat-cache.js';
import { rememberedNameForJid } from './group-store.js';

export function explainMessageMatch(
  msg,
  { jobsConfig, trackedNames = [], selfUser = '' } = {}
) {
  const cfg = jobsConfig || loadJobsConfig();
  const groupName = String(msg?.chatName || '').trim();
  const chatId = String(msg?.chatId || '').trim();
  const mapped =
    rememberedNameForJid(chatId) ||
    cfg.whatsapp?.groupJids?.[chatId.toLowerCase()] ||
    cfg.whatsapp?.groupJids?.[groupName.toLowerCase()] ||
    '';
  const resolvedName =
    looksLikeChatJid(groupName) || !groupName ? mapped || groupName : groupName;
  const tracked = new Set(
    (Array.isArray(trackedNames) ? trackedNames : [])
      .map((n) => String(n || '').trim().toLowerCase())
      .filter(Boolean)
  );
  for (const [jid, name] of Object.entries(cfg.whatsapp?.groupJids || {})) {
    if (jid) tracked.add(String(jid).toLowerCase());
    if (name) tracked.add(String(name).trim().toLowerCase());
  }
  const nameKey = resolvedName.toLowerCase();
  const idKey = chatId.toLowerCase();
  const selfChat = isSelfChatTarget({
    fromMe: Boolean(msg?.fromMe),
    isGroup: isGroupLikeJid(chatId),
    chatId,
    groupName: resolvedName,
    selfUser,
  });
  const inTracked = Boolean(
    selfChat ||
      nameKey === SELF_CHAT_LABEL.toLowerCase() ||
      (nameKey && tracked.has(nameKey)) ||
      (idKey && tracked.has(idKey))
  );
  const allowed =
    isAllowedGroup(resolvedName, cfg) || isAllowedGroup(chatId, cfg);

  if (!inTracked && !allowed) {
    const storedAsJid = looksLikeChatJid(groupName) || (!groupName && looksLikeChatJid(chatId));
    return {
      matched: false,
      reason: 'group_not_tracked',
      detail: storedAsJid
        ? `stored as chat JID "${groupName || chatId}" — group title was not resolved`
        : `"${groupName || chatId}" is not in the tracked / allow list`,
    };
  }

  const body = String(msg?.body || msg?.text || '');
  const m = matchFullStackOrBackend(body, cfg.roles || []);
  if (m.excluded) {
    return {
      matched: false,
      reason: 'excluded_non_cs',
      detail: 'non-CS role (materials / mechanical / civil / …)',
    };
  }
  if (!m.matches) {
    return {
      matched: false,
      reason: 'not_target_job',
      detail: 'no CS-junior role signal (software / מפתח / intern / …)',
    };
  }
  return {
    matched: true,
    reason: 'matched',
    detail: (m.rolesMatched || []).slice(0, 4).join(', ') || 'CS junior',
  };
}
