/**
 * Tests for WhatsApp group resolve + GUI track helpers (no Chrome).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveWhatsappGroupByName } from '../server/jobs-engine/wa-resolve.js';
import {
  createWhatsappSession,
  resetSharedWhatsappSessionForTests,
} from '../server/whatsapp/session.js';

test('resolveWhatsappGroupByName finds exact group', async () => {
  const chats = [
    { isGroup: true, id: { _serialized: 'g1@g.us' }, name: 'Jobs Israel' },
    { isGroup: false, id: { _serialized: 'u1' }, name: 'Alice' },
  ];
  const session = createWhatsappSession({ onLog: () => {} });
  session._setStateForTests('authenticated', '', {
    client: { getChats: async () => chats },
    emitReady: false,
  });
  const result = await resolveWhatsappGroupByName('jobs israel', {
    session,
    chats,
  });
  assert.equal(result.found, true);
  assert.equal(result.match.name, 'Jobs Israel');
  assert.equal(result.match.exact, true);
  assert.equal(result.match.id, 'g1@g.us');
});

test('resolveWhatsappGroupByName returns suggestions when ambiguous', async () => {
  const chats = [
    { isGroup: true, id: { _serialized: 'a' }, name: 'Jobs Israel' },
    { isGroup: true, id: { _serialized: 'b' }, name: 'Jobs Israel Backend' },
  ];
  const result = await resolveWhatsappGroupByName('Jobs', { chats });
  assert.equal(result.found, false);
  assert.equal(result.code, 'WA_GROUP_AMBIGUOUS');
  assert.equal(result.suggestions.length, 2);
});

test('resolveWhatsappGroupByName not found', async () => {
  const result = await resolveWhatsappGroupByName('No Such Group', {
    chats: [{ isGroup: true, id: { _serialized: 'x' }, name: 'Other' }],
  });
  assert.equal(result.found, false);
  assert.equal(result.code, 'WA_GROUP_NOT_FOUND');
});

test('resolveWhatsappGroupByName requires connected session without chats', async () => {
  resetSharedWhatsappSessionForTests();
  const session = createWhatsappSession({ onLog: () => {} });
  const result = await resolveWhatsappGroupByName('Jobs Israel', { session });
  assert.equal(result.found, false);
  assert.equal(result.code, 'WA_NOT_READY');
});

test('trackGroupFromGui adds to file allow-list when found', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-track-gui-'));
  const overridePath = path.join(tmp, 'whatsapp-groups.json');
  fs.writeFileSync(
    overridePath,
    JSON.stringify({ groups: ['Existing Group'] }, null, 2)
  );
  const { trackGroupFromGui } = await import('../server/jobs-engine/track-gui.js');
  const chats = [
    { isGroup: true, id: { _serialized: 'g2@g.us' }, name: 'Backend Jobs IL' },
  ];
  const result = await trackGroupFromGui('Backend Jobs', { chats, overridePath });
  assert.equal(result.ok, true);
  assert.equal(result.found, true);
  assert.equal(result.persistedByName, false);
  assert.ok(result.groups.includes('Backend Jobs IL'));
  assert.ok(result.groups.includes('Existing Group'));
});

test('trackGroupFromGui persists exact name when WhatsApp is not ready', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-track-gui-'));
  const overridePath = path.join(tmp, 'whatsapp-groups.json');
  fs.writeFileSync(
    overridePath,
    JSON.stringify({ groups: ['Existing Group'] }, null, 2)
  );
  resetSharedWhatsappSessionForTests();
  const session = createWhatsappSession({ onLog: () => {} });
  const { trackGroupFromGui } = await import('../server/jobs-engine/track-gui.js');
  const result = await trackGroupFromGui('Referally Junior 1-2 🐊', {
    session,
    overridePath,
  });
  assert.equal(result.ok, true);
  assert.equal(result.found, false);
  assert.equal(result.persistedByName, true);
  assert.ok(result.groups.includes('Referally Junior 1-2 🐊'));
  assert.ok(result.groups.includes('Existing Group'));
  const saved = JSON.parse(fs.readFileSync(overridePath, 'utf8'));
  assert.ok(saved.groups.includes('Referally Junior 1-2 🐊'));
});

test('trackGroupFromGui persists Hebrew quoted name without live WA', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-track-gui-'));
  const overridePath = path.join(tmp, 'whatsapp-groups.json');
  fs.writeFileSync(
    overridePath,
    JSON.stringify({ groups: ['Jobs Israel'] }, null, 2)
  );
  const { trackGroupFromGui } = await import('../server/jobs-engine/track-gui.js');
  const name = 'מדמ"ח - נטוורקינג ומשרות';
  const result = await trackGroupFromGui(name, {
    chats: [{ isGroup: true, id: { _serialized: 'x' }, name: 'Other' }],
    overridePath,
  });
  assert.equal(result.ok, true);
  assert.equal(result.persistedByName, true);
  assert.ok(result.groups.includes(name));
});

test('trackGroupFromGui refuses ambiguous matches without persisting', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-track-gui-'));
  const overridePath = path.join(tmp, 'whatsapp-groups.json');
  const override = { groups: ['Existing'] };
  fs.writeFileSync(overridePath, JSON.stringify(override, null, 2));
  const { trackGroupFromGui } = await import('../server/jobs-engine/track-gui.js');
  const chats = [
    { isGroup: true, id: { _serialized: 'a' }, name: 'Jobs Israel' },
    { isGroup: true, id: { _serialized: 'b' }, name: 'Jobs Israel Backend' },
  ];
  const result = await trackGroupFromGui('Jobs', { chats, overridePath });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'WA_GROUP_AMBIGUOUS');
  const saved = JSON.parse(fs.readFileSync(overridePath, 'utf8'));
  assert.deepEqual(saved.groups, ['Existing']);
});

console.log('whatsapp-gui-track tests: ok');
