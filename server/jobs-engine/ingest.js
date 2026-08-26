/**
 * WhatsApp → queue → raw persist → matcher → Mongo Job + Telegram.
 * Event handler only enqueues; heavy work runs on a bounded worker.
 */

import { filterTargetJobs } from '../jobs/job-matcher.js';
import { isAllowedGroup, loadJobsConfig } from '../jobs/jobs-config.js';
import { sealClientAgainstSends } from '../jobs/whatsapp-live.js';
import {
  ensureTrackedGroupsSeeded,
  groupIdFromName,
  isTrackedGroupName,
  mongoReady,
} from './group-store.js';
import {
  persistRawWhatsappMessage,
  upsertDiscoveredJob,
  waMessageIdFromMsg,
} from './job-store.js';
import { groupChatIdFromMessage, resolveChatInfo } from './chat-cache.js';
import { createIngestQueue } from './ingest-queue.js';
import {
  appendIngestBuffer,
  defaultBufferPath,
  readAndClearIngestBuffer,
} from './ingest-buffer.js';
import { notifyLiveJob } from './notify-job.js';

const ATTACHED = Symbol('waMessageIngestAttached');
const SKIP_FROM = /status@broadcast/i;
const SKIP_TYPES = new Set([
  'e2e_notification',
  'notification_template',
  'gp2',
  'protocol',
  'ciphertext',
]);

function extractBody(msg) {
  const caption = String(msg?.caption || msg?._data?.caption || '').trim();
  return String(msg?.body || msg?.text || caption || '').trim();
}

export function serializeWhatsappMessage(msg) {
  const chatId = groupChatIdFromMessage(msg);
  const ts = msg?.timestamp
    ? msg.timestamp > 1e12
      ? msg.timestamp
      : msg.timestamp * 1000
    : Date.now();
  return {
    messageId: waMessageIdFromMsg(msg),
    chatId,
    from: msg?.from || '',
    to: msg?.to || '',
    body: extractBody(msg),
    text: extractBody(msg),
    hasMedia: Boolean(msg?.hasMedia),
    caption: String(msg?.caption || msg?._data?.caption || ''),
    author: msg?.author || msg?.notifyName || '',
    notifyName: msg?.notifyName || '',
    fromMe: Boolean(msg?.fromMe || msg?.id?.fromMe),
    timestamp: ts,
    type: String(msg?.type || 'chat'),
    groupName: msg?.groupName || '',
    isStatus: Boolean(msg?.isStatus),
  };
}

function shouldIgnoreSerialized(msg) {
  const from = String(msg.from || '');
  if (msg.isStatus) return 'status';
  if (SKIP_FROM.test(from)) return 'status';
  if (SKIP_TYPES.has(msg.type) && !msg.body) return 'protocol';
  return null;
}

/**
 * Process one inbound WhatsApp message (group text → optional Job upsert).
 * @returns {Promise<{ skipped?: string, results?: object[] }>}
 */
export async function handleWhatsappMessage(msg, deps = {}) {
  const onLog = deps.onLog || (() => {});
  const jobsConfig = deps.jobsConfig || loadJobsConfig();
  const upsert = deps.upsertDiscoveredJob || upsertDiscoveredJob;
  const isTracked = deps.isTrackedGroupName || isTrackedGroupName;
  const persistRaw = deps.persistRawWhatsappMessage || persistRawWhatsappMessage;
  const notify = deps.notifyLiveJob || notifyLiveJob;
  const mongoIsReady =
    typeof deps.mongoReady === 'function' ? deps.mongoReady() : mongoReady();

  const liveGetChat = typeof msg?.getChat === 'function' ? msg.getChat.bind(msg) : null;
  const serialized =
    typeof msg?.getChat === 'function' || msg?.id
      ? {
          ...serializeWhatsappMessage(msg),
          getChat: liveGetChat || undefined,
          chat: msg.chat,
        }
      : { ...msg, body: extractBody(msg), text: extractBody(msg) };
  const ignore = shouldIgnoreSerialized(serialized);
  if (ignore) return { skipped: ignore };

  const body = extractBody(serialized);
  const hasMedia = Boolean(serialized.hasMedia);
  if (jobsConfig.whatsapp?.textOnly && hasMedia && !body) {
    return { skipped: 'media' };
  }

  const chatInfo = await resolveChatInfo(serialized, deps.client, onLog);
  const isGroup = Boolean(chatInfo.isGroup);
  const groupName = String(chatInfo.name || serialized.groupName || chatInfo.chatId || '').trim();
  const chatId = chatInfo.chatId || serialized.chatId;

  onLog(
    `[whatsapp-ingest] MSG RECV | groupName="${groupName}" | isGroup=${isGroup} | from=${serialized.from} | bodyPreview="${body.substring(0, 30)}"`
  );

  if (!isGroup) {
    onLog(`[whatsapp-ingest] skipped: not_group (from: ${serialized.from})`);
    return { skipped: 'not_group' };
  }

  if (!groupName) {
    onLog(`[whatsapp-ingest] skipped: no_group_name (from: ${serialized.from})`);
    return { skipped: 'no_group_name' };
  }

  if (!mongoIsReady) {
    const buf = deps.bufferPath || defaultBufferPath();
    appendIngestBuffer(
      { ...serialized, groupName, chatId, body, text: body },
      buf
    );
    onLog('[whatsapp-ingest] mongo unavailable — buffered to disk');
    return { skipped: 'mongo_unavailable', buffered: true };
  }

  const raw = await persistRaw({
    messageId: serialized.messageId,
    chatId,
    chatName: groupName,
    fromMe: serialized.fromMe,
    timestamp: serialized.timestamp,
    type: serialized.type,
    body,
    hasMedia,
    author: serialized.author,
    raw: {
      from: serialized.from,
      to: serialized.to,
      type: serialized.type,
    },
  });
  if (raw.stored && raw.isNew === false) {
    return { skipped: 'duplicate_message' };
  }

  let tracked = false;
  try {
    tracked = await isTracked(groupName);
  } catch {
    tracked = false;
  }
  if (!tracked) {
    if (!isAllowedGroup(groupName, jobsConfig)) {
      onLog(`[whatsapp-ingest] skipped: group_not_tracked (groupName: "${groupName}")`);
      return { skipped: 'group_not_tracked' };
    }
  }

  if (!body) {
    onLog(`[whatsapp-ingest] skipped: empty_body (groupName: "${groupName}")`);
    return { skipped: 'empty_body' };
  }

  const matched = filterTargetJobs(
    [
      {
        body,
        text: body,
        author: serialized.author || serialized.notifyName || 'unknown',
        groupName,
        timestamp: new Date(serialized.timestamp || Date.now()).toISOString(),
      },
    ],
    { roles: jobsConfig.roles || [] }
  );

  if (!matched.length) {
    return { skipped: 'not_target_job' };
  }

  const results = [];
  for (const job of matched) {
    const upserted = await upsert(job, {
      groupId: groupIdFromName(groupName),
      groupName,
    });
    results.push(upserted);
    onLog(
      `[whatsapp-ingest] ${upserted.isNew ? 'new' : 'dup'} job=${upserted.job.jobId} group=${groupName}`
    );
    if (upserted.isNew && deps.notifyTelegram !== false) {
      await notify(job, { groupName, onLog });
    }
  }
  deps.session?.markEvent?.();
  return { results };
}

export async function drainIngestBuffer(deps = {}) {
  const onLog = deps.onLog || (() => {});
  const items = readAndClearIngestBuffer(deps.bufferPath || defaultBufferPath());
  if (!items.length) return { drained: 0 };
  onLog(`[whatsapp-ingest] draining ${items.length} buffered message(s)`);
  let drained = 0;
  for (const item of items) {
    try {
      await handleWhatsappMessage(item, deps);
      drained += 1;
    } catch (err) {
      onLog(`[whatsapp-ingest] buffer drain error: ${err.message}`);
    }
  }
  return { drained };
}

/**
 * Attach a single message listener to the shared WA client.
 * @returns {{ detach: () => void, queue: ReturnType<typeof createIngestQueue> }}
 */
export function attachMessageIngest(client, deps = {}) {
  const onLog = deps.onLog || ((line) => console.log(line));
  if (!client || typeof client.on !== 'function') {
    return { detach: () => {}, queue: null };
  }
  if (client[ATTACHED]) {
    return { detach: client[ATTACHED].detach, queue: client[ATTACHED].queue };
  }

  try {
    sealClientAgainstSends(client, onLog);
  } catch {
    /* ignore */
  }

  const queue = createIngestQueue({
    concurrency: Number(process.env.WHATSAPP_INGEST_CONCURRENCY || 2),
    handler: (payload) =>
      handleWhatsappMessage(payload, { ...deps, client }).catch((err) => {
        onLog(`[whatsapp-ingest] handler error: ${err.message}`);
      }),
    onLog,
  });

  const handler = (msg) => {
    const serialized = serializeWhatsappMessage(msg);
    if (typeof msg?.getChat === 'function') {
      serialized.getChat = msg.getChat.bind(msg);
      serialized.chat = msg.chat;
    }
    if (msg?.groupName) serialized.groupName = msg.groupName;
    const ignore = shouldIgnoreSerialized(serialized);
    if (ignore) return;
    queue.push(serialized);
  };

  client.on('message_create', handler);
  const detach = () => {
    if (typeof client.off === 'function') client.off('message_create', handler);
    else if (typeof client.removeListener === 'function') {
      client.removeListener('message_create', handler);
    }
    delete client[ATTACHED];
  };
  client[ATTACHED] = { detach, queue };
  onLog(
    '[whatsapp-ingest] message_create listener attached (queued); captures all group/newsletter chats; job matching still uses tracked/allow-list'
  );
  return { detach, queue };
}

/**
 * Register ingest bootstrap on session ready (seed groups, then attach).
 * Safe to call once at boot; never blocks HTTP.
 */
export function startIngestWhenReady(session, deps = {}) {
  const onLog = deps.onLog || ((line) => console.log(line));
  if (!session || typeof session.onReady !== 'function') {
    onLog('[whatsapp-ingest] session missing onReady — skip');
    return { detach: () => {} };
  }

  let detachIngest = () => {};
  const unsub = session.onReady((client) => {
    void (async () => {
      try {
        if (deps.ensureTrackedGroupsSeeded || mongoReady()) {
          const seedFn = deps.ensureTrackedGroupsSeeded || ensureTrackedGroupsSeeded;
          const seeded = await seedFn();
          if (seeded?.seeded) {
            onLog(
              `[whatsapp-ingest] seeded ${seeded.count} tracked groups from config`
            );
          }
        }
      } catch (err) {
        onLog(`[whatsapp-ingest] seed failed: ${err.message}`);
      }
      const attached = attachMessageIngest(client, { ...deps, session });
      detachIngest = attached.detach;
      try {
        const { listJoinedWhatsappGroups } = await import('../whatsapp/groups.js');
        const joined = await listJoinedWhatsappGroups(client);
        onLog(
          `[whatsapp-ingest] session sees ${joined.length} group/newsletter chat(s)`
        );
      } catch (err) {
        onLog(`[whatsapp-ingest] group list skipped: ${err.message}`);
      }
      try {
        await drainIngestBuffer({ ...deps, client, session });
      } catch (err) {
        onLog(`[whatsapp-ingest] drain failed: ${err.message}`);
      }
    })();
  });

  return {
    detach: () => {
      unsub?.();
      detachIngest();
    },
  };
}
