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
  assert.ok(JOB_STATUSES.includes('requires_human'));
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

console.log('whatsapp-session tests: ok');
