/**
 * Real-time WhatsApp group scanner via whatsapp-web.js.
 * SAFETY: listen-only — never send messages to groups (or anywhere).
 *
 * Groups must come from config.json allow-list (or data/whatsapp-groups.json override).
 */

import { isAllowedGroup } from './jobs-config.js';
import { filterTargetJobs } from './job-matcher.js';

/**
 * @param {object} opts
 * @param {object} opts.jobsConfig - from loadJobsConfig()
 * @param {(job) => void|Promise<void>} opts.onJob
 * @param {(line: string) => void} [opts.onLog]
 * @param {object} [opts.client] - injected mock client for tests
 * @param {() => Promise<object>} [opts.createClient] - factory override
 */
export async function startWhatsappJobWatcher({
  jobsConfig,
  onJob,
  onLog,
  client: injectedClient,
  createClient,
} = {}) {
  if (!jobsConfig?.whatsapp?.groups?.length) {
    const err = new Error('WhatsApp groups must be defined in config.json');
    err.code = 'WA_GROUPS_REQUIRED';
    throw err;
  }
  if (jobsConfig.safety?.neverSendWhatsappGroupMessages === false) {
    const err = new Error('Refusing to start: safety.neverSendWhatsappGroupMessages must stay true');
    err.code = 'WA_SAFETY_VIOLATION';
    throw err;
  }

  const allowed = jobsConfig.whatsapp.groups;
  onLog?.(
    `[whatsapp] listen-only watcher; groups from config.json: ${allowed.join(', ')}`
  );

  const client =
    injectedClient ||
    (await (createClient || resolveSharedClient)({ onLog }));

  // Hard guard: wrap send APIs so they can never fire.
  sealClientAgainstSends(client, onLog);

  const handler = async (msg) => {
    try {
      if (jobsConfig.whatsapp.textOnly && msg.hasMedia && !String(msg.body || msg.caption || '').trim()) {
        onLog?.('[whatsapp] skipping media without caption (textOnly=true)');
        return;
      }
      const chat = await msg.getChat();
      if (!chat?.isGroup) return;
      const groupName = chat.name || '';
      if (!isAllowedGroup(groupName, jobsConfig)) {
        return;
      }
      const body = String(msg.body || '').trim();
      if (!body) return;

      const matched = filterTargetJobs(
        [
          {
            body,
            text: body,
            author: msg.author || msg.from || 'unknown',
            groupName,
            timestamp: new Date().toISOString(),
          },
        ],
        { roles: jobsConfig.roles }
      );
      for (const job of matched) {
        await onJob?.(job);
      }
    } catch (err) {
      onLog?.(`[whatsapp] message handler error: ${err.message}`);
    }
  };

  if (typeof client.on === 'function') {
    client.on('message_create', handler);
  }

  const ownClient = Boolean(injectedClient || createClient);
  if (ownClient && typeof client.initialize === 'function') {
    await client.initialize();
  }

  return {
    client,
    stop: async () => {
      if (typeof client.destroy === 'function') await client.destroy();
      else if (typeof client.removeAllListeners === 'function') {
        client.removeAllListeners('message_create');
      }
    },
  };
}

export function sealClientAgainstSends(client, onLog) {
  const block = async () => {
    const err = new Error(
      'Blocked: agent must never send WhatsApp group/DM messages'
    );
    err.code = 'WA_SEND_BLOCKED';
    onLog?.(`[whatsapp] ${err.message}`);
    throw err;
  };
  for (const method of [
    'sendMessage',
    'sendText',
    'reply',
    'sendPresenceAvailable',
  ]) {
    if (client && typeof client === 'object') {
      try {
        client[method] = block;
      } catch {
        /* ignore non-writable */
      }
    }
  }
  if (client?.pupPage) {
    /* no-op: we do not expose page for scripting sends */
  }
}

async function resolveSharedClient({ onLog } = {}) {
  const { getSharedWhatsappSession } = await import('../whatsapp/session.js');
  const session = getSharedWhatsappSession();
  if (!session.getClient()) {
    await session.start();
  }
  const client = session.getClient();
  if (!client) {
    const err = new Error(
      'Shared WhatsApp session is not ready. POST /api/whatsapp/start and scan QR first (one Chrome only).'
    );
    err.code = 'WA_NOT_READY';
    throw err;
  }
  onLog?.('[whatsapp] using shared session client (refusing a second Chrome)');
  return client;
}

/**
 * Process a single inbound text as if it came from a watched group (tests / dry paths).
 */
export function analyzeRealtimeMessage(msg, jobsConfig) {
  const groupName = msg.groupName || '';
  if (!isAllowedGroup(groupName, jobsConfig)) {
    return { accepted: false, reason: 'group_not_in_config' };
  }
  if (jobsConfig.whatsapp?.textOnly && msg.hasMedia && !String(msg.body || msg.text || msg.caption || '').trim()) {
    return { accepted: false, reason: 'media_skipped' };
  }
  const jobs = filterTargetJobs(
    [
      {
        body: msg.body || msg.text,
        text: msg.body || msg.text,
        author: msg.author || 'unknown',
        groupName,
        timestamp: msg.timestamp || new Date().toISOString(),
      },
    ],
    { roles: jobsConfig.roles }
  );
  return { accepted: jobs.length > 0, jobs };
}
