/**
 * WhatsApp jobs-engine ingest tests (mocked WA client — no Chrome).
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import {
  attachMessageIngest,
  handleWhatsappMessage,
  startIngestWhenReady,
} from '../server/jobs-engine/ingest.js';
import { createWhatsappSession } from '../server/whatsapp/session.js';
import { mountJobsEngineRoutes } from '../server/jobs-engine/http.js';
import { groupIdFromName } from '../server/jobs-engine/group-store.js';
import { fingerprintFromMatchedJob } from '../server/jobs-engine/job-store.js';
import { clearChatCache } from '../server/jobs-engine/chat-cache.js';
import { clearTrackedJidMemory } from '../server/jobs-engine/group-store.js';
import { isPermanentDisconnect, isBrowserLaunchFailure } from '../server/whatsapp/session.js';

const JOBS_CONFIG = {
  roles: ['Full Stack', 'Backend'],
  whatsapp: {
    groups: ['Jobs Israel', 'Backend Jobs IL'],
    textOnly: true,
    neverSendMessages: true,
  },
  safety: { neverSendWhatsappGroupMessages: true },
};

function makeMsg({
  body,
  groupName = 'Jobs Israel',
  hasMedia = false,
  from = 'someone@lid',
  to = '120363@g.us',
  messageId = `wamid-${Math.random().toString(16).slice(2)}`,
} = {}) {
  return {
    body,
    hasMedia,
    author: 'recruiter@lid',
    from,
    to,
    id: { _serialized: messageId, fromMe: false },
    getChat: async () => ({ isGroup: true, name: groupName }),
  };
}

const silentNotify = {
  notifyTelegram: false,
  notifyLiveJob: async () => {},
  persistRawWhatsappMessage: async () => ({ stored: true, isNew: true }),
};

function resetIngestTestState() {
  clearChatCache();
  clearTrackedJidMemory();
}

test('fingerprintFromMatchedJob is stable and ignores group', () => {
  const a = fingerprintFromMatchedJob({
    text: 'Backend Node.js developer needed',
    groupName: 'Jobs Israel',
    author: 'x',
    applyUrl: 'https://example.com/jobs/1',
  });
  const b = fingerprintFromMatchedJob({
    text: 'Backend Node.js developer needed',
    groupName: 'Other Group',
    author: 'x',
    applyUrl: 'https://example.com/jobs/1',
  });
  assert.equal(a, b);
  assert.equal(a.length, 32);
});

test('groupIdFromName normalizes', () => {
  assert.equal(groupIdFromName('Jobs Israel'), 'name:jobs israel');
});

test('matchJoinedToTracked binds unique names and skips ambiguous', async () => {
  const { matchJoinedToTracked } = await import('../server/jobs-engine/group-store.js');
  const { bound, unbound } = matchJoinedToTracked(
    [
      { id: '120363aaa@g.us', name: 'Referally Junior 1-2 🐊' },
      { id: '120363bbb@g.us', name: 'Dup' },
      { id: '120363ccc@g.us', name: 'Dup' },
    ],
    [
      { _id: '1', name: 'Referally Junior 1-2 🐊' },
      { _id: '2', name: 'Dup' },
      { _id: '3', name: 'Missing Group' },
    ]
  );
  assert.equal(bound.length, 1);
  assert.equal(bound[0].jid, '120363aaa@g.us');
  assert.equal(unbound.length, 2);
});

test('chat cache ignores empty group names and seeds JID → title', async () => {
  const {
    clearChatCache,
    getCachedChat,
    seedChatCacheFromGroups,
    setCachedChat,
    groupTitleFromMessage,
  } = await import('../server/jobs-engine/chat-cache.js');
  clearChatCache();
  setCachedChat('120363@g.us', { isGroup: true, name: '' });
  assert.equal(getCachedChat('120363@g.us'), null);
  seedChatCacheFromGroups([{ id: '120363@g.us', name: 'Referally Junior 1-2 🐊' }]);
  assert.equal(getCachedChat('120363@g.us').name, 'Referally Junior 1-2 🐊');
  assert.equal(
    groupTitleFromMessage({ _data: { chat: { formattedTitle: 'Jobs Israel' } } }),
    'Jobs Israel'
  );
  clearChatCache();
});

test('isPermanentDisconnect detects logout vs drop', () => {
  assert.equal(isPermanentDisconnect('LOGOUT'), true);
  assert.equal(isPermanentDisconnect('UNPAIRED'), true);
  assert.equal(isPermanentDisconnect('timeout'), false);
  assert.equal(isPermanentDisconnect('NAVIGATION'), true);
  assert.equal(isBrowserLaunchFailure('Failed to launch the browser process:  Code: 21'), true);
  assert.equal(isBrowserLaunchFailure('timeout'), false);
});

test('handleWhatsappMessage upserts discovered job for tracked group', async () => {
  resetIngestTestState();
  const upserts = [];
  const result = await handleWhatsappMessage(
    makeMsg({
      body: 'דרוש מפתח Backend / Full Stack עם Node.js — שלחו קו״ח ל-jobs@example.com',
    }),
    {
      jobsConfig: JOBS_CONFIG,
      mongoReady: () => true,
      isTrackedGroupName: async () => true,
      ...silentNotify,
      upsertDiscoveredJob: async (matched, meta) => {
        const row = {
          job: {
            jobId: 'j1',
            status: 'discovered',
            rawText: matched.text,
            groupName: meta.groupName,
          },
          isNew: upserts.length === 0,
        };
        upserts.push(row);
        return row;
      },
    }
  );
  assert.ok(result.results?.length >= 1);
  assert.equal(result.results[0].job.status, 'discovered');
  assert.equal(upserts[0].isNew, true);

  const dup = await handleWhatsappMessage(
    makeMsg({
      body: 'דרוש מפתח Backend / Full Stack עם Node.js — שלחו קו״ח ל-jobs@example.com',
    }),
    {
      jobsConfig: JOBS_CONFIG,
      mongoReady: () => true,
      isTrackedGroupName: async () => true,
      ...silentNotify,
      upsertDiscoveredJob: async (matched, meta) => {
        const row = {
          job: { jobId: 'j1', status: 'discovered', rawText: matched.text },
          isNew: false,
          duplicateOf: 'j1',
        };
        upserts.push({ ...row, meta });
        return row;
      },
    }
  );
  assert.equal(dup.results[0].isNew, false);
});

test('handleWhatsappMessage resolves group name from chat cache when getChat fails', async () => {
  resetIngestTestState();
  const { seedChatCacheFromGroups } = await import('../server/jobs-engine/chat-cache.js');
  seedChatCacheFromGroups([
    { id: '120363403637482285@g.us', name: 'Referally Junior 1-2 🐊' },
  ]);
  const persisted = [];
  const result = await handleWhatsappMessage(
    {
      body: 'דרוש Backend Engineer / Full Stack https://jobs.example.com/referally',
      hasMedia: false,
      author: 'recruiter@lid',
      from: '120363403637482285@g.us',
      to: '120363403637482285@g.us',
      id: { _serialized: 'wamid-jid-1', fromMe: false },
      getChat: async () => {
        throw new Error('r');
      },
    },
    {
      jobsConfig: {
        ...JOBS_CONFIG,
        whatsapp: { ...JOBS_CONFIG.whatsapp, groups: ['Referally Junior 1-2 🐊'] },
      },
      mongoReady: () => true,
      isTrackedGroupName: async (name) => name === 'Referally Junior 1-2 🐊',
      persistRawWhatsappMessage: async (doc) => {
        persisted.push(doc);
        return { stored: true, isNew: true };
      },
      notifyLiveJob: async () => {},
      notifyTelegram: false,
      upsertDiscoveredJob: async (matched, meta) => ({
        job: { jobId: 'jid1', status: 'discovered', rawText: matched.text },
        isNew: true,
        meta,
      }),
    }
  );
  assert.equal(persisted[0].chatName, 'Referally Junior 1-2 🐊');
  assert.ok(result.results?.length >= 1);
});

test('handleWhatsappMessage resolves title from Store when getChat throws r', async () => {
  resetIngestTestState();
  const persisted = [];
  const referallyJid = '120363390709579185@g.us';
  const result = await handleWhatsappMessage(
    {
      body: '*Communications System Engineer* / Ethosia Computer Science embedded software https://www.linkedin.com/jobs/view/4457748262',
      hasMedia: false,
      author: 'recruiter@lid',
      from: referallyJid,
      to: referallyJid,
      id: { _serialized: 'wamid-store-1', fromMe: false },
      getChat: async () => {
        throw new Error('r');
      },
    },
    {
      client: {
        pupPage: {
          evaluate: async (_fn, id) =>
            id === referallyJid ? 'Referally Junior 1-2 🐊' : '',
        },
      },
      jobsConfig: {
        ...JOBS_CONFIG,
        whatsapp: { ...JOBS_CONFIG.whatsapp, groups: ['Referally Junior 1-2 🐊'] },
      },
      mongoReady: () => true,
      isTrackedGroupName: async (name) => name === 'Referally Junior 1-2 🐊',
      persistRawWhatsappMessage: async (doc) => {
        persisted.push(doc);
        return { stored: true, isNew: true };
      },
      notifyLiveJob: async () => {},
      notifyTelegram: false,
      upsertDiscoveredJob: async (matched, meta) => ({
        job: { jobId: 'store1', status: 'discovered', rawText: matched.text },
        isNew: true,
        meta,
      }),
    }
  );
  assert.equal(persisted[0].chatName, 'Referally Junior 1-2 🐊');
  assert.ok(result.results?.length >= 1);
});

test('handleWhatsappMessage tracks by remembered JID when title is missing', async () => {
  resetIngestTestState();
  const { rememberJidName } = await import('../server/jobs-engine/group-store.js');
  const jid = '120363390709579185@g.us';
  rememberJidName(jid, 'Referally Junior 1-2 🐊');
  const result = await handleWhatsappMessage(
    {
      body: 'דרוש Backend Engineer / Full Stack https://jobs.example.com/jid-only',
      hasMedia: false,
      author: 'recruiter@lid',
      from: jid,
      to: jid,
      id: { _serialized: 'wamid-jid-mem-1', fromMe: false },
      getChat: async () => {
        throw new Error('r');
      },
    },
    {
      jobsConfig: JOBS_CONFIG,
      mongoReady: () => true,
      isTrackedGroupName: async (name) =>
        name === 'Referally Junior 1-2 🐊' || name === jid,
      persistRawWhatsappMessage: async () => ({ stored: true, isNew: true }),
      notifyLiveJob: async () => {},
      notifyTelegram: false,
      upsertDiscoveredJob: async (matched, meta) => ({
        job: { jobId: 'jidmem', status: 'discovered', rawText: matched.text },
        isNew: true,
        meta,
      }),
    }
  );
  assert.ok(result.results?.length >= 1);
});

test('handleWhatsappMessage tracks unresolved JID via groupJids map', async () => {
  resetIngestTestState();
  const entryJid = '120363403637482285@g.us';
  const madmahJid = '972547598009-1508702211@g.us';
  const cfg = {
    ...JOBS_CONFIG,
    whatsapp: {
      ...JOBS_CONFIG.whatsapp,
      groups: ['Referally Entry 0+ 💙', 'מדמ"ח - נטוורקינג ומשרות'],
      groupJids: {
        [entryJid]: 'Referally Entry 0+ 💙',
        [madmahJid]: 'מדמ"ח - נטוורקינג ומשרות',
      },
    },
  };
  const persist = async () => ({ stored: true, isNew: true });
  const upsert = async (matched, meta) => ({
    job: { jobId: meta.groupName, status: 'discovered', rawText: matched.text },
    isNew: true,
    meta,
  });
  const entry = await handleWhatsappMessage(
    {
      body: 'Junior React Developer B.Sc in computer science https://www.comeet.com/jobs/x',
      hasMedia: false,
      author: 'recruiter@lid',
      from: entryJid,
      to: entryJid,
      id: { _serialized: 'wamid-entry-jid', fromMe: false },
      getChat: async () => {
        throw new Error('r');
      },
    },
    {
      jobsConfig: cfg,
      mongoReady: () => true,
      persistRawWhatsappMessage: persist,
      notifyLiveJob: async () => {},
      notifyTelegram: false,
      upsertDiscoveredJob: upsert,
    }
  );
  assert.ok(entry.results?.length >= 1);
  assert.equal(entry.results[0].meta.groupName, 'Referally Entry 0+ 💙');

  const madmah = await handleWhatsappMessage(
    {
      body: 'Hiring Backend engineer Node.js apply https://jobs.eu.lever.co/mobileye/x',
      hasMedia: false,
      author: 'recruiter@lid',
      from: madmahJid,
      to: madmahJid,
      id: { _serialized: 'wamid-madmah-jid', fromMe: false },
      getChat: async () => {
        throw new Error('r');
      },
    },
    {
      jobsConfig: cfg,
      mongoReady: () => true,
      persistRawWhatsappMessage: persist,
      notifyLiveJob: async () => {},
      notifyTelegram: false,
      upsertDiscoveredJob: upsert,
    }
  );
  assert.ok(madmah.results?.length >= 1);
  assert.equal(madmah.results[0].meta.groupName, 'מדמ"ח - נטוורקינג ומשרות');
});

test('listJoinedWhatsappGroups falls back to Store when getChats throws r', async () => {
  const { listJoinedWhatsappGroups } = await import('../server/whatsapp/groups.js');
  const client = {
    getChats: async () => {
      throw new Error('r');
    },
    pupPage: {
      evaluate: async () => [
        {
          id: '120363390709579185@g.us',
          name: 'Referally Junior 1-2 🐊',
          isReadOnly: true,
        },
      ],
    },
  };
  const groups = await listJoinedWhatsappGroups(client);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].id, '120363390709579185@g.us');
  assert.equal(groups[0].name, 'Referally Junior 1-2 🐊');
});

test('handleWhatsappMessage skips untracked groups', async () => {
  resetIngestTestState();
  const result = await handleWhatsappMessage(
    makeMsg({
      body: 'Hiring Backend engineer Node.js',
      groupName: 'Random Chat',
    }),
    {
      jobsConfig: JOBS_CONFIG,
      mongoReady: () => true,
      isTrackedGroupName: async () => false,
      ...silentNotify,
      upsertDiscoveredJob: async () => {
        throw new Error('should not upsert');
      },
    }
  );
  assert.equal(result.skipped, 'group_not_tracked');
});

test('handleWhatsappMessage keeps media when caption/body present', async () => {
  resetIngestTestState();
  const result = await handleWhatsappMessage(
    makeMsg({
      body: 'דרוש מפתח Backend / Full Stack עם Node.js — https://jobs.example.com/x',
      hasMedia: true,
    }),
    {
      jobsConfig: JOBS_CONFIG,
      mongoReady: () => true,
      isTrackedGroupName: async () => true,
      ...silentNotify,
      upsertDiscoveredJob: async (matched) => ({
        job: { jobId: 'media1', status: 'discovered', rawText: matched.text },
        isNew: true,
      }),
    }
  );
  assert.ok(result.results?.length >= 1);
});

test('handleWhatsappMessage skips media without caption when textOnly', async () => {
  const result = await handleWhatsappMessage(
    makeMsg({ body: '', hasMedia: true }),
    {
      jobsConfig: JOBS_CONFIG,
      mongoReady: () => true,
      isTrackedGroupName: async () => true,
      ...silentNotify,
    }
  );
  assert.equal(result.skipped, 'media');
});

test('handleWhatsappMessage does not drop @lid group senders', async () => {
  resetIngestTestState();
  const result = await handleWhatsappMessage(
    makeMsg({
      body: 'Hiring Backend engineer Node.js apply https://jobs.example.com/be',
      from: '12345@lid',
      to: '120363-jobs@g.us',
    }),
    {
      jobsConfig: JOBS_CONFIG,
      mongoReady: () => true,
      isTrackedGroupName: async () => true,
      ...silentNotify,
      upsertDiscoveredJob: async (matched) => ({
        job: { jobId: 'lid1', status: 'discovered', rawText: matched.text },
        isNew: true,
      }),
    }
  );
  assert.ok(result.results?.length >= 1);
});

test('handleWhatsappMessage buffers when mongo is down', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-buf-'));
  const bufferPath = path.join(dir, 'wa.jsonl');
  try {
    const result = await handleWhatsappMessage(
      makeMsg({
        body: 'Hiring Backend engineer Node.js apply https://jobs.example.com/be',
      }),
      {
        jobsConfig: JOBS_CONFIG,
        mongoReady: () => false,
        isTrackedGroupName: async () => true,
        bufferPath,
        ...silentNotify,
        upsertDiscoveredJob: async () => {
          throw new Error('should not upsert');
        },
      }
    );
    assert.equal(result.skipped, 'mongo_unavailable');
    assert.equal(result.buffered, true);
    assert.ok(fs.existsSync(bufferPath));
    const lines = fs.readFileSync(bufferPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('handleWhatsappMessage captures newsletter/announcement chat ids as groups', async () => {
  resetIngestTestState();
  const result = await handleWhatsappMessage(
    {
      body: 'Hiring Backend engineer Node.js apply https://jobs.example.com/be',
      hasMedia: false,
      author: 'recruiter',
      from: '120363-news@newsletter',
      to: '120363-news@newsletter',
      id: { _serialized: 'wamid-news-1', fromMe: false },
      getChat: async () => ({
        isGroup: false,
        name: 'Hiring Channel',
        id: { _serialized: '120363-news@newsletter' },
      }),
    },
    {
      jobsConfig: JOBS_CONFIG,
      mongoReady: () => true,
      isTrackedGroupName: async () => true,
      ...silentNotify,
      upsertDiscoveredJob: async (matched) => ({
        job: { jobId: 'news1', status: 'discovered', rawText: matched.text },
        isNew: true,
      }),
    }
  );
  assert.ok(result.results?.length >= 1);
});

test('handleWhatsappMessage persists self/direct chat when tracked as אני', async () => {
  resetIngestTestState();
  const persisted = [];
  const result = await handleWhatsappMessage(
    {
      body: 'דרוש Backend Engineer / Full Stack https://jobs.example.com/self-test',
      hasMedia: false,
      author: 'me',
      from: '97250@c.us',
      to: '97250@c.us',
      id: { _serialized: 'wamid-self-1', fromMe: true },
      getChat: async () => ({
        isGroup: false,
        name: 'אני',
        id: { _serialized: '97250@c.us' },
      }),
    },
    {
      jobsConfig: {
        ...JOBS_CONFIG,
        whatsapp: { ...JOBS_CONFIG.whatsapp, groups: ['אני'] },
      },
      mongoReady: () => true,
      isTrackedGroupName: async (name) => name === 'אני',
      persistRawWhatsappMessage: async (doc) => {
        persisted.push(doc);
        return { stored: true, isNew: true };
      },
      notifyLiveJob: async () => {},
      notifyTelegram: false,
      upsertDiscoveredJob: async (matched, meta) => ({
        job: { jobId: 'self1', status: 'discovered', rawText: matched.text },
        isNew: true,
        meta,
      }),
    }
  );
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].chatName, 'אני');
  assert.ok(result.results?.length >= 1);
});

test('handleWhatsappMessage treats own legacy @g.us Message-yourself as אני', async () => {
  resetIngestTestState();
  const persisted = [];
  const ownJid = '972527960190-1563124052@g.us';
  const result = await handleWhatsappMessage(
    {
      body: 'דרוש Software engineer (python) https://jobs.example.com/innoviz',
      hasMedia: false,
      author: 'me',
      from: ownJid,
      to: ownJid,
      fromMe: true,
      id: { _serialized: 'wamid-self-legacy-1', fromMe: true },
      getChat: async () => {
        throw new Error('r');
      },
    },
    {
      client: { info: { wid: { user: '972527960190' } } },
      jobsConfig: {
        ...JOBS_CONFIG,
        whatsapp: { ...JOBS_CONFIG.whatsapp, groups: ['Jobs Israel'] },
      },
      mongoReady: () => true,
      isTrackedGroupName: async () => false,
      persistRawWhatsappMessage: async (doc) => {
        persisted.push(doc);
        return { stored: true, isNew: true };
      },
      notifyLiveJob: async () => {},
      notifyTelegram: false,
      upsertDiscoveredJob: async (matched, meta) => ({
        job: { jobId: 'self-legacy', status: 'discovered', rawText: matched.text },
        isNew: true,
        meta,
      }),
    }
  );
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].chatName, 'אני');
  assert.ok(result.results?.length >= 1);
});

test('handleWhatsappMessage does not treat someone else legacy @g.us as אני', async () => {
  resetIngestTestState();
  const otherJid = '972547598009-1508702211@g.us';
  const result = await handleWhatsappMessage(
    {
      body: 'דרוש Software engineer (python) https://jobs.example.com/other',
      hasMedia: false,
      author: 'me',
      from: otherJid,
      to: otherJid,
      fromMe: true,
      id: { _serialized: 'wamid-other-legacy-1', fromMe: true },
      getChat: async () => {
        throw new Error('r');
      },
    },
    {
      client: { info: { wid: { user: '972527960190' } } },
      jobsConfig: JOBS_CONFIG,
      mongoReady: () => true,
      isTrackedGroupName: async () => false,
      persistRawWhatsappMessage: async () => ({ stored: true, isNew: true }),
      notifyLiveJob: async () => {},
      notifyTelegram: false,
      upsertDiscoveredJob: async () => ({
        job: { jobId: 'should-not', status: 'discovered' },
        isNew: true,
      }),
    }
  );
  assert.equal(result.skipped, 'group_not_tracked');
});

test('attachMessageIngest listens on message_create', async () => {
  resetIngestTestState();
  const client = new EventEmitter();
  const upserts = [];
  attachMessageIngest(client, {
    jobsConfig: JOBS_CONFIG,
    mongoReady: () => true,
    isTrackedGroupName: async () => true,
    ...silentNotify,
    upsertDiscoveredJob: async (matched) => {
      const row = { job: { jobId: 'x', status: 'discovered' }, isNew: true };
      upserts.push(matched);
      return row;
    },
    onLog: () => {},
  });

  client.emit(
    'message_create',
    makeMsg({
      body: 'Looking for a Full Stack developer with React and Node.js apply https://jobs.example.com/fs',
    })
  );
  await new Promise((r) => setTimeout(r, 80));
  assert.ok(upserts.length >= 1);
});

test('startIngestWhenReady seeds and attaches on session ready', async () => {
  resetIngestTestState();
  const client = new EventEmitter();
  let seeded = false;
  let attached = false;
  const session = createWhatsappSession({
    onLog: () => {},
    autoReconnect: false,
    createClient: async () => client,
  });

  startIngestWhenReady(session, {
    onLog: () => {},
    ensureTrackedGroupsSeeded: async () => {
      seeded = true;
      return { seeded: true, count: 2, names: ['Jobs Israel'] };
    },
    jobsConfig: JOBS_CONFIG,
    mongoReady: () => true,
    isTrackedGroupName: async () => true,
    ...silentNotify,
    upsertDiscoveredJob: async () => {
      attached = true;
      return { job: { jobId: 'z', status: 'discovered' }, isNew: true };
    },
  });

  session._setStateForTests('authenticated', '', { client, emitReady: true });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(seeded, true);

  client.emit(
    'message_create',
    makeMsg({
      body: 'Backend NestJS role — email hr@example.com',
    })
  );
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(attached, true);
});

test('jobs engine HTTP gui list works without mongo', async () => {
  const app = express();
  app.use(express.json());
  mountJobsEngineRoutes(app);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/api/jobs/tracked-groups?gui=1`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(Array.isArray(body.groups));
  assert.ok(body.whatsapp?.state);
  await new Promise((r) => server.close(r));
});

test('jobs engine recent works without mongo', async () => {
  const app = express();
  app.use(express.json());
  mountJobsEngineRoutes(app);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/api/jobs/recent`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(Array.isArray(body.jobs));
  await new Promise((r) => server.close(r));
});

test('jobs engine drive-tracker status does not require mongo', async () => {
  const app = express();
  app.use(express.json());
  mountJobsEngineRoutes(app);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/api/jobs/drive-tracker`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(typeof body.configured, 'boolean');
  assert.ok(body.howTo);
  await new Promise((r) => server.close(r));
});

test('CV profile save + PDF upload persist on a data-like path (no redeploy)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-profile-'));
  const jobsConfig = {
    profile: {
      path: path.join(tmp, 'cv-profile.json'),
      cvPath: path.join(tmp, 'cv.pdf'),
    },
  };
  const { saveCvProfile, saveCvPdf, getProfileForGui, readCvPdfBuffer } =
    await import('../server/jobs-engine/profile-store.js');
  const saved = saveCvProfile(
    { name: 'Test User', email: 't@example.com', phone: '050', linkedin: '', github: '' },
    jobsConfig
  );
  assert.equal(saved.ok, true);
  assert.equal(saved.profile.name, 'Test User');
  assert.equal(saved.profile.email, 't@example.com');
  const pdf = Buffer.from('%PDF-1.4 test cv');
  const after = saveCvPdf(pdf, 'resume.pdf', jobsConfig);
  assert.equal(after.ok, true);
  assert.equal(after.cv.present, true);
  assert.ok(after.cv.bytes > 0);
  assert.deepEqual(readCvPdfBuffer(jobsConfig), pdf);
  const gui = getProfileForGui(jobsConfig);
  assert.equal(gui.persistedOnVolume, true);
  assert.equal(gui.profile.name, 'Test User');
  fs.rmSync(tmp, { recursive: true, force: true });
});

console.log('whatsapp-ingest tests: ok');
