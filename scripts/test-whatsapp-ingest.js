/**
 * WhatsApp jobs-engine ingest tests (mocked WA client — no Chrome).
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
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

const JOBS_CONFIG = {
  roles: ['Full Stack', 'Backend'],
  whatsapp: {
    groups: ['Jobs Israel', 'Backend Jobs IL'],
    textOnly: true,
    neverSendMessages: true,
  },
  safety: { neverSendWhatsappGroupMessages: true },
};

function makeMsg({ body, groupName = 'Jobs Israel', hasMedia = false }) {
  return {
    body,
    hasMedia,
    author: 'recruiter@lid',
    getChat: async () => ({ isGroup: true, name: groupName }),
  };
}

test('fingerprintFromMatchedJob is stable', () => {
  const a = fingerprintFromMatchedJob({
    text: 'Backend Node.js developer needed',
    groupName: 'Jobs Israel',
    author: 'x',
    applyUrl: 'https://example.com/jobs/1',
  });
  const b = fingerprintFromMatchedJob({
    text: 'Backend Node.js developer needed',
    groupName: 'Jobs Israel',
    author: 'x',
    applyUrl: 'https://example.com/jobs/1',
  });
  assert.equal(a, b);
  assert.equal(a.length, 32);
});

test('groupIdFromName normalizes', () => {
  assert.equal(groupIdFromName('Jobs Israel'), 'name:jobs israel');
});

test('handleWhatsappMessage upserts discovered job for tracked group', async () => {
  const upserts = [];
  const result = await handleWhatsappMessage(
    makeMsg({
      body: 'דרוש מפתח Backend / Full Stack עם Node.js — שלחו קו״ח ל-jobs@example.com',
    }),
    {
      jobsConfig: JOBS_CONFIG,
      mongoReady: () => true,
      isTrackedGroupName: async () => true,
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

test('handleWhatsappMessage skips untracked groups', async () => {
  const result = await handleWhatsappMessage(
    makeMsg({
      body: 'Hiring Backend engineer Node.js',
      groupName: 'Random Chat',
    }),
    {
      jobsConfig: JOBS_CONFIG,
      mongoReady: () => true,
      isTrackedGroupName: async () => false,
      upsertDiscoveredJob: async () => {
        throw new Error('should not upsert');
      },
    }
  );
  assert.equal(result.skipped, 'group_not_tracked');
});

test('handleWhatsappMessage skips media when textOnly', async () => {
  const result = await handleWhatsappMessage(
    makeMsg({ body: 'Backend', hasMedia: true }),
    {
      jobsConfig: JOBS_CONFIG,
      mongoReady: () => true,
      isTrackedGroupName: async () => true,
    }
  );
  assert.equal(result.skipped, 'media');
});

test('attachMessageIngest listens and calls handler path', async () => {
  const client = new EventEmitter();
  const upserts = [];
  attachMessageIngest(client, {
    jobsConfig: JOBS_CONFIG,
    mongoReady: () => true,
    isTrackedGroupName: async () => true,
    upsertDiscoveredJob: async (matched) => {
      const row = { job: { jobId: 'x', status: 'discovered' }, isNew: true };
      upserts.push(matched);
      return row;
    },
    onLog: () => {},
  });

  client.emit(
    'message',
    makeMsg({
      body: 'Looking for a Full Stack developer with React and Node.js apply https://jobs.example.com/fs',
    })
  );
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(upserts.length >= 1);
});

test('startIngestWhenReady seeds and attaches on session ready', async () => {
  const client = new EventEmitter();
  let seeded = false;
  let attached = false;
  const session = createWhatsappSession({
    onLog: () => {},
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
    upsertDiscoveredJob: async () => {
      attached = true;
      return { job: { jobId: 'z', status: 'discovered' }, isNew: true };
    },
  });

  session._setStateForTests('authenticated', '', { client, emitReady: true });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(seeded, true);

  client.emit(
    'message',
    makeMsg({
      body: 'Backend NestJS role — email hr@example.com',
    })
  );
  await new Promise((r) => setTimeout(r, 50));
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

test('jobs engine recent returns 503 without mongo', async () => {
  const app = express();
  app.use(express.json());
  mountJobsEngineRoutes(app);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/api/jobs/recent`);
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.code, 'MONGO_UNAVAILABLE');
  await new Promise((r) => server.close(r));
});

console.log('whatsapp-ingest tests: ok');
