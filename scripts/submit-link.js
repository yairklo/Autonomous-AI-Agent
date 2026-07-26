import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { submitJobFormWithPlaywright } from '../server/jobs/playwright-submitter.js';
import { loadCvProfile } from '../server/cv-submitter.js';
import { config } from '../server/config.js';
import { buildCoverLetter } from '../server/jobs/cover-letter.js';
import { JobDb, openJobDb } from '../server/jobs/job-db.js';
import { updateJobInTracker } from '../server/jobs/tracker.js';
import { createTelegramClient } from '../server/jobs/telegram.js';
import { loadJobsConfig } from '../server/jobs/jobs-config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const url = process.argv[2];

if (!url || !/^https?:\/\//i.test(url)) {
  console.error('Usage: node scripts/submit-link.js <https://job-form-url>');
  process.exit(1);
}

async function run() {
  console.log(`🚀 Starting manual job submission for: ${url}`);

  const profile = loadCvProfile(config.cvFixtureProfilePath);
  const cvPath = path.join(config.root, 'assets', 'cv.pdf');

  const db = openJobDb(path.join(config.root, 'data', 'jobs_db.json'));
  const jobId = `manual_${randomUUID().slice(0, 8)}`;

  const mockJob = {
    id: jobId,
    groupName: 'Manual URL Submission',
    author: 'You',
    body: `Manual submission to: ${url}`,
    text: `Manual submission to: ${url}`,
    timestamp: new Date().toISOString(),
    status: 'approved',
    approvalStatus: 'approved',
    formUrl: url,
  };

  db.upsertJob(mockJob);
  console.log('✅ Created tracking entry in jobs database.');

  const cover = await buildCoverLetter({
    profile,
    jobText: mockJob.text,
    useLlm: false,
  });

  console.log(
    `🌐 Launching Playwright (HEADLESS_BROWSER=${process.env.HEADLESS_BROWSER ?? 'default/true'})...`
  );
  try {
    const result = await submitJobFormWithPlaywright({
      formUrl: url,
      profile,
      cvPath,
      coverLetter: cover.text,
      approved: true,
      dryRun: false,
      jobId,
      onLog: (m) => console.log(m),
    });

    console.log('\n--- PLAYWRIGHT SUBMIT RESULT ---');
    console.log(JSON.stringify({
      ok: result.ok,
      status: result.status,
      ats: result.ats,
      step: result.step,
      code: result.code,
      confirmationVerified: result.confirmationVerified,
      finalUrl: result.finalUrl,
      screenshotPath: result.screenshotPath,
      message: result.message,
    }, null, 2));

    const confirmed =
      result.confirmationVerified === true && result.status === 'Submitted';

    if (confirmed) {
      const updated = db.update(jobId, {
        status: 'submitted',
        submitResult: result,
        submittedAt: new Date().toISOString(),
      });
      await updateJobInTracker(updated);
      console.log('✅ Confirmed Submitted. Tracker updated.');
      return;
    }

    const needsHuman =
      result.status === 'Requires Manual Action' ||
      result.code === 'HUMAN_INTERVENTION_REQUIRED' ||
      result.code === 'CAPTCHA_OR_AUTH_BLOCK' ||
      result.code === 'UNMAPPED_REQUIRED_FIELD';

    const status = needsHuman ? 'requires_manual_action' : 'submit_failed';
    const updated = db.update(jobId, {
      status,
      submitResult: {
        ...result,
        error: result.message,
        formUrl: url,
      },
    });
    await updateJobInTracker(updated);
    console.log(`⚠️ Recorded status=${status} (not Submitted).`);

    try {
      const jobsConfig = loadJobsConfig();
      const telegram = createTelegramClient({
        botToken: jobsConfig.telegram.botToken,
        chatId: jobsConfig.telegram.chatId,
      });
      if (needsHuman) {
        await telegram.sendManualActionAlert(mockJob, result, {
          dryRun: !telegram.configured,
        });
      } else {
        await telegram.sendFailureAlert(
          mockJob,
          { message: result.message },
          { dryRun: !telegram.configured }
        );
      }
    } catch (e) {
      console.log('Telegram alert skipped:', e.message);
    }
  } catch (err) {
    console.error('\n❌ Failed to submit job:', err.message);

    const failed = db.update(jobId, {
      status: 'submit_failed',
      submitResult: { ok: false, error: err.message, code: err.code },
    });
    await updateJobInTracker(failed);
    console.log('⚠️ Recorded failure in Excel Tracker.');
  }
}

run().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
