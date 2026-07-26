/**
 * Unit/integration checks for ATS detection + confirmation rules + mock form.
 * Workday live probe is opt-in via RUN_WORKDAY_LIVE=1.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  detectAtsFromUrl,
  resolveHeadless,
  SUBMIT_STATUS,
  SUBMIT_CODES,
} from '../server/jobs/drivers/index.js';
import { submitJobFormWithPlaywright } from '../server/jobs/playwright-submitter.js';
import { createTelegramClient } from '../server/jobs/telegram.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

let passed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`✓ ${name}`);
    })
    .catch((err) => {
      console.error(`✗ ${name}`);
      console.error(err);
      process.exitCode = 1;
    });
}

await test('detectAtsFromUrl: Workday / Greenhouse / Lever / generic', () => {
  assert.equal(
    detectAtsFromUrl(
      'https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/x'
    ),
    'workday'
  );
  assert.equal(
    detectAtsFromUrl('https://boards.greenhouse.io/company/jobs/123'),
    'greenhouse'
  );
  assert.equal(detectAtsFromUrl('https://grnh.se/abc123'), 'greenhouse');
  assert.equal(
    detectAtsFromUrl('https://jobs.lever.co/company/role-id'),
    'lever'
  );
  assert.equal(detectAtsFromUrl('https://careers.example.com/apply'), 'generic');
});

await test('resolveHeadless respects HEADLESS_BROWSER', () => {
  assert.equal(resolveHeadless({}), true);
  assert.equal(resolveHeadless({ HEADLESS_BROWSER: 'true' }), true);
  assert.equal(resolveHeadless({ HEADLESS_BROWSER: 'false' }), false);
  assert.equal(resolveHeadless({ HEADLESS_BROWSER: '0' }), false);
});

await test('Telegram manual action alert dry-run includes step + link', async () => {
  const tg = createTelegramClient({ botToken: '', chatId: '' });
  const alert = await tg.sendManualActionAlert(
    { id: 'job-1', formUrl: 'https://example.com/apply' },
    {
      ats: 'workday',
      step: 'auth_block:password',
      code: SUBMIT_CODES.HUMAN_INTERVENTION_REQUIRED,
      message: 'Password required',
      manualUrl: 'https://example.com/apply/step2',
      screenshotPath: 'data/screenshots/failed-job-1.png',
    },
    { dryRun: true }
  );
  assert.equal(alert.ok, true);
  assert.match(alert.text, /Requires Manual Action/);
  assert.match(alert.text, /auth_block:password/);
  assert.match(alert.text, /https:\/\/example.com\/apply\/step2/);
});

await test('Mock HTML form confirms Submitted only with success text', async () => {
  const htmlPath = path.join(__dirname, 'mock-form.html');
  const cvPath = path.join(root, 'assets', 'cv.pdf');
  if (!fs.existsSync(cvPath)) {
    fs.mkdirSync(path.dirname(cvPath), { recursive: true });
    fs.writeFileSync(cvPath, '%PDF-1.4 mock');
  }

  const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/form') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(fs.readFileSync(htmlPath));
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const prev = process.env.HEADLESS_BROWSER;
  process.env.HEADLESS_BROWSER = 'true';

  try {
    const result = await submitJobFormWithPlaywright({
      formUrl: `http://127.0.0.1:${port}/form`,
      profile: {
        name: 'Demo Candidate',
        email: 'demo@example.com',
        phone: '050-0000000',
        linkedin: 'https://linkedin.com/in/demo',
        github: 'https://github.com/demo',
      },
      cvPath,
      coverLetter: 'Hello cover letter',
      approved: true,
      jobId: 'mock-form-test',
      onLog: () => {},
    });
    assert.equal(result.confirmationVerified, true);
    assert.equal(result.status, SUBMIT_STATUS.SUBMITTED);
    assert.equal(result.ok, true);
    assert.equal(result.ats, 'generic');
  } finally {
    if (prev === undefined) delete process.env.HEADLESS_BROWSER;
    else process.env.HEADLESS_BROWSER = prev;
    await new Promise((r) => server.close(r));
  }
});

await test('Refuses Submitted without approval', async () => {
  await assert.rejects(
    () =>
      submitJobFormWithPlaywright({
        formUrl: 'https://jobs.example.com/apply',
        profile: { name: 'Demo' },
        cvPath: path.join(root, 'assets', 'cv.pdf'),
        coverLetter: 'hi',
        approved: false,
        dryRun: true,
      }),
    /approval|Approve/i
  );
});

if (process.env.RUN_WORKDAY_LIVE === '1') {
  await test('Workday live NVIDIA URL does not false-succeed', async () => {
    const cvPath = path.join(root, 'assets', 'cv.pdf');
    const workdayUrl =
      process.env.WORKDAY_TEST_URL ||
      'https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/Israel-Yokneam/DevOps-Engineer--DOCA_JR2017774?shared_id=fea67872-3cfd-4b35-8b0f-9327f489b523';

    const prev = process.env.HEADLESS_BROWSER;
    process.env.HEADLESS_BROWSER = process.env.HEADLESS_BROWSER || 'true';

    try {
      const result = await submitJobFormWithPlaywright({
        formUrl: workdayUrl,
        profile: {
          name: 'Demo Candidate',
          email: 'demo.candidate@example.com',
          phone: '+972-50-000-0000',
          linkedin: 'https://www.linkedin.com/in/demo-candidate',
          github: 'https://github.com/demo-candidate',
        },
        cvPath,
        coverLetter: 'Test application — automated validation only.',
        approved: true,
        jobId: 'workday-live-test',
        onLog: (m) => console.log(m),
      });

      console.log('Workday live result:', {
        ok: result.ok,
        status: result.status,
        ats: result.ats,
        step: result.step,
        code: result.code,
        confirmationVerified: result.confirmationVerified,
        screenshotPath: result.screenshotPath,
      });

      assert.equal(result.ats, 'workday');
      assert.notEqual(result.status, SUBMIT_STATUS.SUBMITTED);
      assert.equal(result.confirmationVerified, false);
      assert.ok(
        result.status === SUBMIT_STATUS.REQUIRES_MANUAL_ACTION ||
          result.status === SUBMIT_STATUS.SUBMISSION_FAILED
      );
      if (result.screenshotPath) {
        assert.ok(fs.existsSync(result.screenshotPath));
      }
    } finally {
      if (prev === undefined) delete process.env.HEADLESS_BROWSER;
      else process.env.HEADLESS_BROWSER = prev;
    }
  });
} else {
  console.log('(skip) Workday live probe — set RUN_WORKDAY_LIVE=1 to enable');
}

console.log(`\n${passed} tests passed`);
