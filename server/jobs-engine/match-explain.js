/**
 * Explain why a captured WhatsApp message did or did not become a Job.
 * Seeing a message in the GUI only means persistRaw ran — matching can still skip.
 */

import { isAllowedGroup, loadJobsConfig } from '../jobs/jobs-config.js';
import { matchFullStackOrBackend } from '../jobs/job-matcher.js';
import { looksLikeChatJid } from './chat-cache.js';

export function explainMessageMatch(
  msg,
  { jobsConfig, trackedNames = [] } = {}
) {
  const cfg = jobsConfig || loadJobsConfig();
  const groupName = String(msg?.chatName || '').trim();
  const chatId = String(msg?.chatId || '').trim();
  const tracked = new Set(
    (Array.isArray(trackedNames) ? trackedNames : [])
      .map((n) => String(n || '').trim().toLowerCase())
      .filter(Boolean)
  );
  const nameKey = groupName.toLowerCase();
  const idKey = chatId.toLowerCase();
  const inTracked = Boolean(
    (nameKey && tracked.has(nameKey)) || (idKey && tracked.has(idKey))
  );
  const allowed =
    isAllowedGroup(groupName, cfg) || isAllowedGroup(chatId, cfg);

  if (!inTracked && !allowed) {
    const storedAsJid = looksLikeChatJid(groupName) || (!groupName && looksLikeChatJid(chatId));
    return {
      matched: false,
      reason: 'group_not_tracked',
      detail: storedAsJid
        ? `saved as JID (${groupName || chatId}), not the group title — tracking compares names`
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
