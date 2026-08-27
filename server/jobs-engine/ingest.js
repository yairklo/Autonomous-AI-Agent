/**
 * WhatsApp → queue → raw persist → matcher → Mongo Job + Telegram.
 * Event handler only enqueues; heavy work runs on a bounded worker.
 */

import { filterTargetJobs } from '../jobs/job-matcher.js';
import { isAllowedGroup, loadJobsConfig } from '../jobs/jobs-config.js';
import { sealClientAgainstSends } from '../jobs/whatsapp-live.js';
import {
  bindTrackedGroupJids,
  ensureTrackedGroupsSeeded,
  groupIdFromName,
  hydrateTrackedJidsFromMongo,
  isTrackedChat,
  mongoReady,
  rememberJidName,
  rememberTrackedGroupJid,
  rememberedNameForJid,
} from './group-store.js';
import { groupChatIdFromMessage, isSelfChatTarget, looksLikeChatJid, resolveChatInfo, resolveDisplayName, seedChatCacheFromGroups, SELF_CHAT_LABEL, whatsappSelfUserId } from './chat-cache.js';
import { isGroupLikeJid } from '../whatsapp/groups.js';
import {
  listJidLabeledMessages,
  persistRawWhatsappMessage,
  updateWhatsappChatName,
  upsertDiscoveredJob,
  waMessageIdFromMsg,
} from './job-store.js';
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
          _data: msg._data,
          groupName: msg.groupName,
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
  const chatId = chatInfo.chatId || serialized.chatId;
  const selfUser = whatsappSelfUserId(deps.client);
  const remembered = rememberedNameForJid(chatId);
  const selfChat = isSelfChatTarget({
    fromMe: serialized.fromMe,
    isGroup,
    chatId,
    groupName: chatInfo.name || serialized.groupName || remembered,
    selfUser,
  });
  const groupName = selfChat
    ? SELF_CHAT_LABEL
    : resolveDisplayName({
        isGroup,
        name: chatInfo.name || serialized.groupName || remembered,
        chatId,
        fromMe: serialized.fromMe,
        selfUser,
      });

  onLog(
    `[whatsapp-ingest] MSG RECV | groupName="${groupName}" | isGroup=${isGroup} | from=${serialized.from} | bodyPreview="${body.substring(0, 30)}"`
  );

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
  if (raw.stored && raw.isNew === false && !deps.rematch) {
    return { skipped: 'duplicate_message' };
  }
  if (chatId && groupName && !looksLikeChatJid(groupName)) {
    rememberJidName(chatId, groupName);
    if (mongoIsReady) {
      updateWhatsappChatName(chatId, groupName).catch(() => {});
    }
  }

  let tracked = selfChat;
  try {
    if (!tracked) {
      if (deps.isTrackedGroupName) {
        tracked = await deps.isTrackedGroupName(groupName);
        if (!tracked && chatId && chatId !== groupName) {
          tracked = await deps.isTrackedGroupName(chatId);
        }
      } else {
        tracked = await isTrackedChat({ name: groupName, chatId });
      }
    }
  } catch {
    tracked = selfChat;
  }
  if (
    tracked &&
    isGroup &&
    chatId &&
    isGroupLikeJid(chatId) &&
    groupName &&
    !isGroupLikeJid(groupName)
  ) {
    rememberJidName(chatId, groupName);
    rememberTrackedGroupJid(groupName, chatId).catch(() => {});
  }
  if (!tracked) {
    if (
      !isAllowedGroup(groupName, jobsConfig) &&
      !isAllowedGroup(chatId, jobsConfig)
    ) {
      onLog(
        `[whatsapp-ingest] skipped: group_not_tracked (groupName: "${groupName}" chatId: "${chatId}")`
      );
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

export async function rematchJidLabeledMessages(deps = {}) {
  const onLog = deps.onLog || (() => {});
  const listFn = deps.listJidLabeledMessages || listJidLabeledMessages;
  let rows = [];
  try {
    rows = await listFn({ limit: deps.rematchLimit || 80 });
  } catch (err) {
    onLog(`[whatsapp-ingest] rematch list failed: ${err.message}`);
    return { rematched: 0 };
  }
  if (!rows.length) return { rematched: 0 };
  onLog(`[whatsapp-ingest] rematching ${rows.length} message(s) stored as chat JID`);
  let rematched = 0;
  for (const row of rows) {
    try {
      const result = await handleWhatsappMessage(
        {
          messageId: row.messageId,
          chatId: row.chatId,
          from: row.chatId,
          to: row.chatId,
          body: row.body,
          text: row.body,
          fromMe: row.fromMe,
          timestamp: row.timestamp,
          type: row.type,
          author: row.author,
          hasMedia: row.hasMedia,
          groupName: row.chatName,
        },
        { ...deps, rematch: true }
      );
      if (result?.results?.length || result?.skipped === 'not_target_job') {
        rematched += 1;
      }
    } catch (err) {
      onLog(`[whatsapp-ingest] rematch error: ${err.message}`);
    }
  }
  return { rematched };
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
  if (typeof client.on === 'function') {
    client.on('message', handler);
  }
  const detach = () => {
    if (typeof client.off === 'function') {
      client.off('message_create', handler);
      client.off('message', handler);
    } else if (typeof client.removeListener === 'function') {
      client.removeListener('message_create', handler);
      client.removeListener('message', handler);
    }
    delete client[ATTACHED];
  };
  client[ATTACHED] = { detach, queue };
  onLog(
    '[whatsapp-ingest] message_create listener attached (queued); captures group/newsletter and 1:1 chats; job matching still uses tracked/allow-list'
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
        const hydrated = await hydrateTrackedJidsFromMongo();
        if (hydrated) {
          onLog(`[whatsapp-ingest] hydrated ${hydrated} tracked JID(s) from mongo`);
        }
      } catch (err) {
        onLog(`[whatsapp-ingest] jid hydrate failed: ${err.message}`);
      }
      try {
        const { listJoinedWhatsappGroups } = await import('../whatsapp/groups.js');
        const joined = await listJoinedWhatsappGroups(client);
        const cached = seedChatCacheFromGroups(joined);
        onLog(
          `[whatsapp-ingest] session sees ${joined.length} group/newsletter chat(s); cached ${cached} display name(s)`
        );
        if (mongoReady()) {
          const bind = await bindTrackedGroupJids(joined);
          onLog(
            `[whatsapp-ingest] bound ${bind.bound} tracked group JID(s); ${bind.unbound} still name-only`
          );
        }
      } catch (err) {
        onLog(
          `[whatsapp-ingest] group list skipped (${err.message}) — titles resolve per-message from Store by JID`
        );
      }
      try {
        const rematch = await rematchJidLabeledMessages({ ...deps, client, session });
        if (rematch.rematched) {
          onLog(`[whatsapp-ingest] rematched ${rematch.rematched} JID-labeled message(s)`);
        }
      } catch (err) {
        onLog(`[whatsapp-ingest] rematch failed: ${err.message}`);
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
