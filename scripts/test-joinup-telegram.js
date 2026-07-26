/**
 * Unit / integration checks for the joinUp Telegram bot (no live Telegram network).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  createAuthMiddleware,
  extractReadyToBuild,
  isAllowedTelegramUser,
  isExplicitConfirmation,
  JoinUpCursorExecutor,
  JoinUpProductAgent,
  JoinUpSessionStore,
  formatCompletionMessage,
  formatVercelTelegramLines,
  parseAllowedUserIds,
  pinToJoinUpRoot,
} from '../server/joinup-telegram/index.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'joinup-tg-'));

test('parseAllowedUserIds parses comma-separated IDs', () => {
  const set = parseAllowedUserIds('111, 222, abc, 333');
  assert.equal(set.size, 3);
  assert.ok(set.has('111'));
  assert.ok(set.has('222'));
  assert.ok(set.has('333'));
  assert.ok(!set.has('abc'));
});

test('isAllowedTelegramUser enforces allow-list', () => {
  const allowed = parseAllowedUserIds('42,99');
  assert.equal(isAllowedTelegramUser(allowed, 42), true);
  assert.equal(isAllowedTelegramUser(allowed, '99'), true);
  assert.equal(isAllowedTelegramUser(allowed, 7), false);
  assert.equal(isAllowedTelegramUser(allowed, null), false);
  assert.equal(isAllowedTelegramUser(new Set(), 42), false);
});

test('auth middleware rejects unauthorized users', async () => {
  const allowed = parseAllowedUserIds('100');
  let nextCalled = false;
  let replied = null;
  const mw = createAuthMiddleware(allowed, {
    unauthorizedMessage: 'nope',
  });

  await mw(
    {
      from: { id: 999 },
      chat: { id: 999 },
      reply: async (t) => {
        replied = t;
      },
    },
    async () => {
      nextCalled = true;
    }
  );
  assert.equal(nextCalled, false);
  assert.equal(replied, 'nope');

  replied = null;
  await mw(
    {
      from: { id: 100 },
      chat: { id: 100 },
      reply: async (t) => {
        replied = t;
      },
    },
    async () => {
      nextCalled = true;
    }
  );
  assert.equal(nextCalled, true);
  assert.equal(replied, null);
});

test('pinToJoinUpRoot blocks path escape', () => {
  const root = tmpRoot;
  assert.equal(pinToJoinUpRoot(root), path.resolve(root));
  assert.equal(pinToJoinUpRoot(root, path.join(root, 'src')), path.resolve(root));
  assert.throws(
    () => pinToJoinUpRoot(root, path.resolve(root, '..', 'other-project')),
    (err) => err.code === 'JOINUP_PATH_ESCAPE'
  );
});

test('JoinUpCursorExecutor always dispatches to pinned joinUp root', async () => {
  const calls = [];
  const executor = new JoinUpCursorExecutor({
    joinUpRoot: tmpRoot,
    runDispatch: async ({ project, task }) => {
      calls.push({ project, task });
      return { ok: true, code: 0, stdout: '', stderr: '' };
    },
  });

  await executor.execute('Add a friendlier empty state on the home screen');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].project, path.resolve(tmpRoot));
  assert.match(calls[0].task, /joinUp/);
  assert.match(calls[0].task, /friendlier empty state/i);
  assert.match(calls[0].task, /npm run build/i);
  assert.match(calls[0].task, /merge.*Dev/i);
});

test('extractReadyToBuild and confirmation helpers', () => {
  const { cleanReply, technicalPrompt } = extractReadyToBuild(
    'Summary here.\n\nShould I proceed?\nREADY_TO_BUILD: Implement the onboarding tip banner'
  );
  assert.match(cleanReply, /Summary here/);
  assert.equal(technicalPrompt, 'Implement the onboarding tip banner');
  assert.equal(isExplicitConfirmation('yes'), true);
  assert.equal(isExplicitConfirmation('כן תבנה'), true);
  assert.equal(isExplicitConfirmation('היה באג, תנסה עכשיו לבצע את המשימה!'), true);
  assert.equal(isExplicitConfirmation('יש אישור להתחיל לעבוד!'), true);
  assert.equal(isExplicitConfirmation('maybe later'), false);
});

test('mock product agent grills then dispatches only after confirm', async () => {
  const store = new JoinUpSessionStore({
    stateFile: path.join(tmpRoot, 'state.json'),
  });
  const dispatches = [];
  const executor = new JoinUpCursorExecutor({
    joinUpRoot: tmpRoot,
    runDispatch: async (args) => {
      dispatches.push(args);
      return { ok: true, code: 0, stdout: 'ok', stderr: '' };
    },
  });
  const agent = new JoinUpProductAgent({
    store,
    executor,
    mock: true,
    sessionsFile: path.join(tmpRoot, 'claude-sessions.json'),
  });

  const t1 = await agent.handleMessage({
    userId: 1,
    text: 'I want a clearer button when joining a group',
  });
  assert.equal(t1.phase, 'grilling');
  assert.equal(dispatches.length, 0);
  assert.match(t1.reply, /Who is this for|screen/i);

  const t2 = await agent.handleMessage({
    userId: 1,
    text: 'For new members. Show a big Join button. If offline, show a friendly retry.',
  });
  assert.equal(dispatches.length, 0);

  const t3 = await agent.handleMessage({
    userId: 1,
    text: 'Use friendly wording. Do not change admin screens.',
  });
  assert.equal(t3.phase, 'awaiting_confirmation');
  assert.match(t3.reply, /Should I proceed/i);
  assert.equal(dispatches.length, 0);
  assert.ok(store.get(1).pendingTechnicalPrompt);

  const t4 = await agent.handleMessage({ userId: 1, text: 'yes' });
  assert.equal(t4.dispatched, true);
  assert.equal(t4.phase, 'completed');
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].project, path.resolve(tmpRoot));
});

test('completion message includes Dev preview Vercel link when present', () => {
  const preview = 'https://join-up-app-git-dev-team.vercel.app';
  const lines = formatVercelTelegramLines({
    url: preview,
    state: 'READY',
    sha: 'abc1234',
  });
  assert.ok(lines.some((l) => l.includes(preview)));
  assert.ok(lines.some((l) => /preview|Dev/i.test(l)));
  const msg = formatCompletionMessage({
    ok: true,
    vercel: { url: preview, state: 'READY' },
  });
  assert.match(msg, /join-up-app-git-dev-team\.vercel\.app/);
  assert.doesNotMatch(msg, /^https:\/\/join-up-app\.vercel\.app$/m);
});

console.log('joinUp Telegram bot tests: ok');
