import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import express from 'express';
import { JOB_SOURCES, JOB_STATUSES, Job } from '../server/models/Job.js';
import { TrackedGroup } from '../server/models/TrackedGroup.js';
import {
  createWhatsappSession,
  WA_STATES,
} from '../server/whatsapp/session.js';
import { mountWhatsappRoutes } from '../server/whatsapp/http.js';

test('Job model exports status and source enums', () => {
  assert.ok(JOB_STATUSES.includes('discovered'));
  assert.ok(JOB_STATUSES.includes('requires_manual_action'));
  assert.ok(JOB_SOURCES.includes('whatsapp_group'));
  assert.equal(typeof Job, 'function');
  assert.equal(typeof TrackedGroup, 'function');
});

test('whatsapp session start is non-blocking and surfaces QR', async () => {
  const logs = [];
  let initializeCalls = 0;

  const session = createWhatsappSession({
    onLog: (l) => logs.push(l),
    createClient: async () => {
      const client = new EventEmitter();
      client.initialize = async () => {
        initializeCalls += 1;
        // Simulate QR after a tick without blocking start() return
        setTimeout(() => client.emit('qr', 'TEST-QR-PAYLOAD'), 5);
      };
      client.destroy = async () => {};
      return client;
    },
  });

  assert.equal(session.getState(), 'uninitialized');
  const snap = await session.start();
  assert.equal(snap.state, 'connecting');
  assert.equal(initializeCalls, 1);

  await new Promise((r) => setTimeout(r, 30));
  assert.equal(session.getState(), 'qr_required');
  const qr = session.getQr();
  assert.ok(qr);
  assert.equal(qr.qr, 'TEST-QR-PAYLOAD');

  session._setStateForTests('authenticated');
  assert.equal(session.getState(), 'authenticated');
  assert.equal(session.getQr(), null);

  await session.stop();
  assert.equal(session.getState(), 'disconnected');
  assert.ok(WA_STATES.includes('qr_required'));
});

test('whatsapp session rebuilds client after transient disconnect', async () => {
  const logs = [];
  let builds = 0;
  let destroys = 0;

  const session = createWhatsappSession({
    onLog: (l) => logs.push(l),
    autoReconnect: true,
    reconnectBaseMs: 15,
    reconnectMaxMs: 40,
    createClient: async () => {
      builds += 1;
      const client = new EventEmitter();
      client.initialize = async () => {
        setTimeout(() => client.emit('ready'), 5);
      };
      client.destroy = async () => {
        destroys += 1;
      };
      return client;
    },
  });

  await session.start();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(session.getState(), 'authenticated');
  assert.equal(builds, 1);

  session.getClient().emit('disconnected', 'timeout');
  await new Promise((r) => setTimeout(r, 80));
  assert.ok(destroys >= 1);
  assert.ok(builds >= 2);
  await session.stop();
});

test('whatsapp session does not reconnect on LOGOUT', async () => {
  let builds = 0;
  const session = createWhatsappSession({
    onLog: () => {},
    autoReconnect: true,
    reconnectBaseMs: 10,
    reconnectMaxMs: 20,
    createClient: async () => {
      builds += 1;
      const client = new EventEmitter();
      client.initialize = async () => {
        setTimeout(() => client.emit('ready'), 5);
      };
      client.destroy = async () => {};
      return client;
    },
  });

  await session.start();
  await new Promise((r) => setTimeout(r, 40));
  session.getClient().emit('disconnected', 'LOGOUT');
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(builds, 1);
  assert.equal(session.snapshot().haltReconnect, true);
  await session.stop();
});

test('whatsapp HTTP status and qr routes', async () => {
  const session = createWhatsappSession({
    onLog: () => {},
    createClient: async () => {
      const client = new EventEmitter();
      client.initialize = async () => {
        client.emit('qr', 'HTTP-QR');
      };
      client.destroy = async () => {};
      return client;
    },
  });

  const app = express();
  mountWhatsappRoutes(app, { session });

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();

  const status1 = await fetch(`http://127.0.0.1:${port}/api/whatsapp/status`);
  const body1 = await status1.json();
  assert.equal(body1.ok, true);
  assert.equal(body1.state, 'uninitialized');

  const startRes = await fetch(`http://127.0.0.1:${port}/api/whatsapp/start`, {
    method: 'POST',
  });
  const startBody = await startRes.json();
  assert.equal(startBody.ok, true);
  assert.ok(['connecting', 'qr_required'].includes(startBody.state));

  await new Promise((r) => setTimeout(r, 40));

  const qrRes = await fetch(`http://127.0.0.1:${port}/api/whatsapp/qr`);
  assert.equal(qrRes.status, 200);
  const qrBody = await qrRes.json();
  assert.equal(qrBody.qr, 'HTTP-QR');

  await session.stop();
  await new Promise((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  );
});

test('GET /api/whatsapp/groups lists joined groups including read-only and newsletters', async () => {
  const client = new EventEmitter();
  client.initialize = async () => {};
  client.destroy = async () => {};
  client.getChats = async () => [
    {
      isGroup: true,
      name: 'Jobs Israel',
      id: { _serialized: '120363-jobs@g.us' },
      isReadOnly: false,
    },
    {
      isGroup: true,
      name: 'Jobs Announce',
      id: { _serialized: '120363-ann@g.us' },
      announce: true,
    },
    { isGroup: false, name: 'Alice', id: { _serialized: 'alice@c.us' } },
    {
      isGroup: false,
      name: 'Hiring Channel',
      id: { _serialized: '120363-news@newsletter' },
    },
  ];

  const session = createWhatsappSession({
    onLog: () => {},
    autoReconnect: false,
    createClient: async () => client,
  });
  session._setStateForTests('authenticated', '', { client, emitReady: true });

  const app = express();
  mountWhatsappRoutes(app, { session });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();

  const notReady = await fetch(`http://127.0.0.1:${port}/api/whatsapp/groups`);
  // session is authenticated with client
  assert.equal(notReady.status, 200);
  const body = await notReady.json();
  assert.equal(body.ok, true);
  assert.equal(body.count, 3);
  assert.ok(body.groups.some((g) => g.name === 'Jobs Israel' && g.tracked));
  assert.ok(body.groups.some((g) => g.name === 'Jobs Announce' && g.isReadOnly));
  assert.ok(body.groups.some((g) => g.isNewsletter && g.id.includes('@newsletter')));
  assert.ok(!body.groups.some((g) => g.name === 'Alice'));

  const coverage = await fetch(
    `http://127.0.0.1:${port}/api/whatsapp/ingest-coverage`
  );
  assert.equal(coverage.status, 503);
  const covBody = await coverage.json();
  assert.equal(covBody.code, 'MONGO_UNAVAILABLE');

  const messages = await fetch(
    `http://127.0.0.1:${port}/api/whatsapp/messages`
  );
  assert.equal(messages.status, 503);
  const msgBody = await messages.json();
  assert.equal(msgBody.code, 'MONGO_UNAVAILABLE');

  await session.stop();
  await new Promise((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  );
});

console.log('whatsapp-session tests: ok');
