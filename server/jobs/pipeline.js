import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config as appConfig } from '../config.js';
import { loadCvProfile } from '../cv-submitter.js';
import { parseWhatsappExport, resolveExportFiles } from '../whatsapp-job-scanner.js';
import { buildCoverLetter } from './cover-letter.js';
import { JobDb, openJobDb } from './job-db.js';
import { isAllowedGroup, loadJobsConfig } from './jobs-config.js';
import { filterTargetJobs } from './job-matcher.js';
import { submitJobFormWithPlaywright } from './playwright-submitter.js';
import { createTelegramClient } from './telegram.js';
import { analyzeRealtimeMessage } from './whatsapp-live.js';
import { updateJobInTracker } from './tracker.js';
import { buildCoverLetterLlmGenerate } from './llm-cover-letter.js';
import { syncMongoJobStatus } from '../jobs-engine/job-store.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Scan configured WhatsApp groups (export fallback or injected messages),
 * dedupe in local DB, and optionally notify Telegram for approval.
 */
export async function scanAndEnqueueJobs({
  configPath,
  jobsConfig: preloadedJobsConfig,
  exportPath,
  messages,
  notifyTelegram = true,
  dryRunTelegram = false,
  limit = 50,
  onLog,
  telegramFetch,
} = {}) {
  // Reuse the caller's already-loaded config when given (e.g. the ingest
  // worker that just matched this message) instead of reloading config.json
  // here — a config.json edit landing between the two loads could otherwise
  // make this second matching pass disagree with the first.
  const jobsConfig = preloadedJobsConfig || loadJobsConfig(configPath);
  const db = openJobDb(jobsConfig.storage.jobsDbPath);

  let candidates = [];
  if (Array.isArray(messages) && messages.length) {
    for (const msg of messages) {
      const analyzed = analyzeRealtimeMessage(msg, jobsConfig);
      if (analyzed.accepted) candidates.push(...analyzed.jobs);
    }
  } else if (exportPath) {
    const files = resolveExportFiles(exportPath);
    for (const file of files) {
      const groupName = path
        .basename(file, path.extname(file))
        .replace(/^WhatsApp Chat with\s+/i, '');
      if (!isAllowedGroup(groupName, jobsConfig)) {
        onLog?.(`[pipeline] skip export group not in config.json: ${groupName}`);
        continue;
      }
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = parseWhatsappExport(raw, { groupName });
      candidates.push(
        ...filterTargetJobs(parsed, { roles: jobsConfig.roles })
      );
    }
  } else {
    const err = new Error('scanAndEnqueueJobs requires exportPath or messages');
    err.code = 'PIPELINE_INVALID_ARGS';
    throw err;
  }

  const telegram = createTelegramClient({
    botToken: jobsConfig.telegram.botToken,
    chatId: jobsConfig.telegram.chatId,
    fetchImpl: telegramFetch,
  });

  const enqueued = [];
  const duplicates = [];
  const max = Math.max(1, Math.min(Number(limit) || 50, 200));

  for (const c of candidates.slice(0, max * 3)) {
    if (enqueued.length >= max) break;
    const id = c.id || JobDb.fingerprint(c);
    const { job, isNew, duplicateOf } = db.upsertJob({
      ...c,
      id,
      status: 'detected',
    });
    if (!isNew) {
      duplicates.push({ id: job.id, duplicateOf });
      continue;
    }

    let telegramResult = null;
    if (notifyTelegram && jobsConfig.telegram.enabled) {
      const dry =
        dryRunTelegram || !telegram.configured;
      telegramResult = await telegram.sendJobApprovalRequest(job, {
        dryRun: dry,
      });
      db.update(job.id, {
        status: 'awaiting_approval',
        telegramApprovalId: String(telegramResult.messageId),
        approvalStatus: 'pending',
      });
    }

    enqueued.push({
      ...db.get(job.id),
      telegram: telegramResult,
    });

    updateJobInTracker(db.get(job.id)).catch((e) =>
      onLog?.(`[pipeline] tracker update failed job=${job.id}: ${e.message}`)
    );
    if (telegramResult) {
      syncMongoJobStatus(job.fingerprint, 'awaiting_approval', {
        message: 'Telegram approval requested',
      }).catch(() => {});
    }

    onLog?.(
      `[pipeline] enqueued job=${job.id} group=${job.groupName} telegram=${telegramResult ? 'yes' : 'no'}`
    );
  }

  return {
    ok: true,
    groupsAllowList: jobsConfig.whatsapp.groups,
    scannedCandidates: candidates.length,
    enqueuedCount: enqueued.length,
    duplicateCount: duplicates.length,
    jobs: enqueued,
    duplicates,
    dbPath: jobsConfig.storage.jobsDbPath,
  };
}

/**
 * Record Telegram Approve/Reject. Submit never runs here unless submitIfApproved.
 */
export function resolveJobApproval({
  configPath,
  jobId,
  action,
  callbackData,
  onLog,
} = {}) {
  const jobsConfig = loadJobsConfig(configPath);
  const db = openJobDb(jobsConfig.storage.jobsDbPath);
  const telegram = createTelegramClient({
    botToken: jobsConfig.telegram.botToken,
    chatId: jobsConfig.telegram.chatId,
  });

  let resolved = { action, jobId };
  if (callbackData) {
    const parsed = telegram.parseApprovalCallback(callbackData);
    if (!parsed) {
      const err = new Error(`Invalid Telegram callback_data: ${callbackData}`);
      err.code = 'TELEGRAM_CALLBACK_INVALID';
      throw err;
    }
    resolved = parsed;
  }

  if (!resolved.jobId || !['approve', 'reject'].includes(resolved.action)) {
    const err = new Error('resolveJobApproval requires jobId and approve|reject');
    err.code = 'PIPELINE_INVALID_ARGS';
    throw err;
  }

  const job = db.get(resolved.jobId);
  if (!job) {
    const err = new Error(`Job not found: ${resolved.jobId}`);
    err.code = 'JOB_NOT_FOUND';
    throw err;
  }

  const approvalStatus = resolved.action === 'approve' ? 'approved' : 'rejected';
  const updated = db.update(resolved.jobId, {
    approvalStatus,
    status: approvalStatus === 'approved' ? 'approved' : 'rejected',
  });

  updateJobInTracker(updated).catch((e) =>
    onLog?.(`[pipeline] tracker update failed job=${resolved.jobId}: ${e.message}`)
  );
  syncMongoJobStatus(updated.fingerprint, approvalStatus, {
    message: `Telegram ${resolved.action}`,
  }).catch(() => {});

  onLog?.(
    `[pipeline] job=${resolved.jobId} approval=${approvalStatus}`
  );
  return { ok: true, job: updated, action: resolved.action };
}

/**
 * Playwright form submit AFTER Telegram approval. Enforces delay + failure alert.
 */
export async function submitApprovedJob({
  configPath,
  jobId,
  profilePath,
  cvPath,
  coverNote,
  dryRun = false,
  skipDelay = false,
  llmGenerate,
  browserFactory,
  telegramFetch,
  onLog,
} = {}) {
  const jobsConfig = loadJobsConfig(configPath);
  const db = openJobDb(jobsConfig.storage.jobsDbPath);
  const job = db.get(jobId);
  if (!job) {
    const err = new Error(`Job not found: ${jobId}`);
    err.code = 'JOB_NOT_FOUND';
    throw err;
  }

  if (
    jobsConfig.safety.neverSubmitWithoutTelegramApproval &&
    job.approvalStatus !== 'approved'
  ) {
    const err = new Error(
      `Refusing submit: job ${jobId} is not Telegram-approved (status=${job.approvalStatus})`
    );
    err.code = 'SUBMIT_NOT_APPROVED';
    throw err;
  }

  if (jobsConfig.submission.neverWhatsappDmOrReply === false) {
    const err = new Error('Safety: WhatsApp DM/reply submit is forbidden');
    err.code = 'WA_SUBMIT_FORBIDDEN';
    throw err;
  }

  const formUrl = job.formUrl || job.contacts?.urls?.[0];
  if (!formUrl) {
    const err = new Error(
      'No form URL on job — Playwright forms only (no WhatsApp DM/reply)'
    );
    err.code = 'SUBMIT_NO_FORM_URL';
    throw err;
  }

  const profileCandidates = [
    profilePath,
    jobsConfig.profile.path,
    appConfig.cvProfilePath,
    appConfig.cvFixtureProfilePath,
  ]
    .map((p) => (p ? String(p).trim() : ''))
    .filter(Boolean);
  const resolvedProfilePath =
    profileCandidates.find((p) => fs.existsSync(p)) || appConfig.cvFixtureProfilePath;
  const profile = loadCvProfile(resolvedProfilePath);

  const cvCandidates = [
    cvPath,
    jobsConfig.profile.cvPath,
    path.join(appConfig.root, 'assets', 'cv.pdf'),
    profile.cvPath
      ? path.isAbsolute(profile.cvPath)
        ? profile.cvPath
        : path.join(profile._profileDir, profile.cvPath)
      : null,
  ]
    .map((p) => (p ? path.resolve(String(p).trim()) : ''))
    .filter(Boolean);
    
  onLog?.(`[pipeline] cvCandidates = ${JSON.stringify(cvCandidates)}`);
  for (const p of cvCandidates) {
    onLog?.(`[pipeline] check ${p}: exists=${fs.existsSync(p)} isFile=${fs.existsSync(p) && fs.statSync(p).isFile()}`);
  }

  const cvFinal = cvCandidates.find((p) => fs.existsSync(p) && fs.statSync(p).isFile());
  if (!cvFinal) {
    const err = new Error('CV file not found (expected assets/cv.pdf)');
    err.code = 'CV_NOT_FOUND';
    throw err;
  }

  const cover = await buildCoverLetter({
    profile,
    jobText: job.text,
    coverNote,
    useLlm: jobsConfig.submission.llmCoverLetter,
    // Callers (tests, mcp-tools) can still inject their own llmGenerate;
    // otherwise default to the real Gemini one-shot generator for a REAL
    // submit only — dry runs must stay side-effect-free and never reach a
    // live external API just to preview a cover letter. Returns null when
    // GEMINI_API_KEY isn't set, so buildCoverLetter falls back to the
    // template exactly as before.
    llmGenerate: llmGenerate || (dryRun ? undefined : buildCoverLetterLlmGenerate({ onLog })),
  });

  if (
    !skipDelay &&
    jobsConfig.submission.delayBetweenSubmissionsMs > 0 &&
    !dryRun
  ) {
    const delay = jobsConfig.submission.delayBetweenSubmissionsMs;
    onLog?.(`[pipeline] delaying ${delay}ms before Playwright submit`);
    await sleep(delay);
  }

  const telegram = createTelegramClient({
    botToken: jobsConfig.telegram.botToken,
    chatId: jobsConfig.telegram.chatId,
    fetchImpl: telegramFetch,
  });

  try {
    const result = await submitJobFormWithPlaywright({
      formUrl,
      profile,
      cvPath: cvFinal,
      coverLetter: cover.text,
      approved: true,
      dryRun,
      jobId: job.id,
      browserFactory,
      onLog,
    });

    const applicationId = randomUUID();
    const appDir = jobsConfig.storage.applicationsDir;
    fs.mkdirSync(appDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const jsonPath = path.join(appDir, `${stamp}_${applicationId.slice(0, 8)}.json`);

    // Dry-run never claims a live submission
    if (dryRun) {
      const record = {
        id: applicationId,
        jobId: job.id,
        status: 'dry_run_submitted',
        channel: 'playwright_forms_only',
        coverSource: cover.source,
        coverLetter: cover.text,
        formUrl,
        result,
        createdAt: new Date().toISOString(),
        whatsappSend: false,
      };
      fs.writeFileSync(jsonPath, JSON.stringify(record, null, 2), 'utf8');
      const updated = db.update(job.id, {
        status: record.status,
        submittedAt: record.createdAt,
        submitResult: { ok: true, dryRun: true, applicationId, jsonPath, ats: result.ats },
      });
      updateJobInTracker(updated).catch((e) =>
        onLog?.(`[pipeline] tracker update failed job=${job.id}: ${e.message}`)
      );
      syncMongoJobStatus(updated.fingerprint, 'dry_run_submitted', {
        message: 'Dry-run Playwright submit',
      }).catch(() => {});
      return { ok: true, job: updated, application: record, files: { json: jsonPath } };
    }

    const confirmed =
      result?.confirmationVerified === true &&
      (result?.status === 'Submitted' || result?.ok === true);

    if (confirmed) {
      const record = {
        id: applicationId,
        jobId: job.id,
        status: 'submitted',
        channel: 'playwright_forms_only',
        coverSource: cover.source,
        coverLetter: cover.text,
        formUrl,
        result,
        createdAt: new Date().toISOString(),
        whatsappSend: false,
      };
      fs.writeFileSync(jsonPath, JSON.stringify(record, null, 2), 'utf8');

      const updated = db.update(job.id, {
        status: 'submitted',
        submittedAt: record.createdAt,
        submitResult: {
          ok: true,
          applicationId,
          jsonPath,
          ats: result.ats,
          confirmationVerified: true,
          formUrl,
          coverLetter: cover.text,
        },
      });
      updateJobInTracker(updated).catch((e) =>
        onLog?.(`[pipeline] tracker update failed job=${job.id}: ${e.message}`)
      );
      syncMongoJobStatus(updated.fingerprint, 'submitted', {
        message: 'Playwright submit confirmed',
      }).catch(() => {});
      telegram
        .sendSuccessAlert(job, { ats: result.ats }, { dryRun: !telegram.configured })
        .catch((e) => onLog?.(`[pipeline] telegram success alert error: ${e.message}`));
      onLog?.(`[pipeline] submitted job=${job.id} via Playwright form (confirmed)`);
      return { ok: true, job: updated, application: record, files: { json: jsonPath } };
    }

    // Human intervention / unverified — never mark Submitted
    const needsHuman =
      result?.code === 'HUMAN_INTERVENTION_REQUIRED' ||
      result?.code === 'CAPTCHA_OR_AUTH_BLOCK' ||
      result?.code === 'UNMAPPED_REQUIRED_FIELD' ||
      result?.status === 'Requires Manual Action';

    const dbStatus = needsHuman ? 'requires_manual_action' : 'submit_failed';
    const displayStatus = needsHuman
      ? 'Requires Manual Action'
      : 'Submission Failed';

    const record = {
      id: applicationId,
      jobId: job.id,
      status: dbStatus,
      displayStatus,
      channel: 'playwright_forms_only',
      coverSource: cover.source,
      coverLetter: cover.text,
      formUrl,
      result,
      createdAt: new Date().toISOString(),
      whatsappSend: false,
    };
    fs.writeFileSync(jsonPath, JSON.stringify(record, null, 2), 'utf8');

    const updated = db.update(job.id, {
      status: dbStatus,
      submitResult: {
        ok: false,
        applicationId,
        jsonPath,
        error: result?.message || displayStatus,
        code: result?.code,
        ats: result?.ats,
        step: result?.step,
        screenshotPath: result?.screenshotPath || null,
        manualUrl: result?.manualUrl || result?.finalUrl || formUrl,
        formUrl,
        coverLetter: cover.text,
      },
    });
    updateJobInTracker(updated).catch((e) =>
      onLog?.(`[pipeline] tracker update failed job=${job.id}: ${e.message}`)
    );
    syncMongoJobStatus(updated.fingerprint, dbStatus, {
      ok: false,
      message: result?.message || displayStatus,
      screenshotPath: result?.screenshotPath || '',
    }).catch(() => {});

    if (jobsConfig.submission.notifyTelegramOnFailure) {
      const alertFn = needsHuman
        ? telegram.sendManualActionAlert(job, result, {
            dryRun: !telegram.configured,
          })
        : telegram.sendFailureAlert(
            job,
            { message: result?.message || displayStatus },
            { dryRun: !telegram.configured }
          );
      await alertFn.catch((e) =>
        onLog?.(`[pipeline] telegram alert error: ${e.message}`)
      );
    }

    onLog?.(
      `[pipeline] job=${job.id} status=${dbStatus} step=${result?.step} ats=${result?.ats}`
    );
    return {
      ok: false,
      job: updated,
      application: record,
      files: { json: jsonPath, screenshot: result?.screenshotPath || null },
      requiresManualAction: needsHuman,
    };
  } catch (err) {
    const failedJob = db.update(job.id, {
      status: 'submit_failed',
      submitResult: { ok: false, error: err.message, code: err.code },
    });

    updateJobInTracker(failedJob).catch((e) =>
      onLog?.(`[pipeline] tracker update failed job=${job.id}: ${e.message}`)
    );
    syncMongoJobStatus(failedJob.fingerprint, 'submit_failed', {
      ok: false,
      message: err.message,
    }).catch(() => {});

    if (jobsConfig.submission.notifyTelegramOnFailure) {
      await telegram
        .sendFailureAlert(job, err, {
          dryRun: dryRun || !telegram.configured,
        })
        .catch((e) => onLog?.(`[pipeline] telegram failure alert error: ${e.message}`));
    }
    throw err;
  }
}

export { loadJobsConfig, openJobDb };
