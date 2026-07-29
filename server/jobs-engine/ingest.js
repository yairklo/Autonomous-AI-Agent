/**
 * WhatsApp → Mongo job ingest on the shared session client (listen-only).
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
import { upsertDiscoveredJob } from './job-store.js';

const ATTACHED = Symbol('waMessageIngestAttached');

/**
 * Process one inbound WhatsApp message (group text → optional Job upsert).
 * @returns {Promise<{ skipped?: string, results?: object[] }>}
 */
export async function handleWhatsappMessage(msg, deps = {}) {
  const onLog = deps.onLog || (() => {});
  const jobsConfig = deps.jobsConfig || loadJobsConfig();
  const upsert = deps.upsertDiscoveredJob || upsertDiscoveredJob;
  const isTracked = deps.isTrackedGroupName || isTrackedGroupName;

  if (jobsConfig.whatsapp?.textOnly && msg?.hasMedia) {
    return { skipped: 'media' };
  }

  let chat;
  try {
    chat = typeof msg.getChat === 'function' ? await msg.getChat() : msg.chat;
  } catch (err) {
    onLog(`[whatsapp-ingest] getChat failed: ${err.message || err} (from: ${msg.from})`);
    return { skipped: 'get_chat_failed' };
  }

  const isGroup = Boolean(chat?.isGroup);
  const groupName = String(chat?.name || msg.groupName || '').trim();
  const body = String(msg.body || msg.text || '').trim();

  // Log incoming message to debug
  onLog(`[whatsapp-ingest] MSG RECV | groupName="${groupName}" | isGroup=${isGroup} | from=${msg.from} | bodyPreview="${body.substring(0, 30)}"`);

  if (!isGroup) {
    onLog(`[whatsapp-ingest] skipped: not_group (from: ${msg.from})`);
    return { skipped: 'not_group' };
  }

  if (!groupName) {
    onLog(`[whatsapp-ingest] skipped: no_group_name (from: ${msg.from})`);
    return { skipped: 'no_group_name' };
  }

  let tracked = false;
  try {
    tracked = await isTracked(groupName);
  } catch {
    tracked = false;
  }
  if (!tracked) {
    // Fallback while Mongo empty/unavailable: config.json allow-list
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
        author: msg.author || msg.notifyName || 'unknown',
        groupName,
        timestamp: msg.timestamp
          ? new Date(msg.timestamp * 1000).toISOString()
          : new Date().toISOString(),
      },
    ],
    { roles: jobsConfig.roles || [] }
  );

  if (!matched.length) {
    return { skipped: 'not_target_job' };
  }

  if (typeof deps.mongoReady === 'function' ? !deps.mongoReady() : !mongoReady()) {
    return { skipped: 'mongo_unavailable', matchedCount: matched.length };
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
  }
  return { results };
}

/**
 * Attach a single message listener to the shared WA client.
 * @returns {{ detach: () => void }}
 */
export function attachMessageIngest(client, deps = {}) {
  const onLog = deps.onLog || ((line) => console.log(line));
  if (!client || typeof client.on !== 'function') {
    return { detach: () => {} };
  }
  if (client[ATTACHED]) {
    return { detach: client[ATTACHED].detach };
  }

  try {
    sealClientAgainstSends(client, onLog);
  } catch {
    /* ignore */
  }

  const handler = (msg) => {
    // Suppress noisy internal whatsapp messages (like status/linked devices)
    if (msg?.from?.includes('@lid') || msg?.from?.includes('@broadcast')) {
      return;
    }
    void handleWhatsappMessage(msg, deps).catch((err) => {
      onLog(`[whatsapp-ingest] handler error: ${err.message}`);
    });
  };

  // Use 'message_create' to also capture messages sent by the user themselves (e.g. forwarding a job to "Me")
  client.on('message_create', handler);
  const detach = () => {
    if (typeof client.off === 'function') client.off('message_create', handler);
    else if (typeof client.removeListener === 'function') {
      client.removeListener('message_create', handler);
    }
    delete client[ATTACHED];
  };
  client[ATTACHED] = { detach };
  onLog('[whatsapp-ingest] message listener attached');
  return { detach };
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
      const attached = attachMessageIngest(client, deps);
      detachIngest = attached.detach;
    })();
  });

  return {
    detach: () => {
      unsub?.();
      detachIngest();
    },
  };
}
