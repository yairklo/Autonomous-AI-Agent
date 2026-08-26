import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { submitWhatsappJobCv } from './cv-submitter.js';
import {
  resolveJobApproval,
  scanAndEnqueueJobs,
  submitApprovedJob,
} from './jobs/pipeline.js';
import { loadJobsConfig } from './jobs/jobs-config.js';
import { resolveDispatchScript, runDispatchTask } from './task-router.js';
import { scanWhatsappJobs } from './whatsapp-job-scanner.js';
import { getGdriveTools, executeGdriveTool, initGdriveMcp } from './gdrive-mcp-client.js';

/**
 * Local MCP tool registry for the voice-agent orchestration layer.
 * Coding work is exposed only via dispatch_coding_task — Claude must not
 * edit files or run raw shell commands itself.
 *
 * WhatsApp jobs pipeline (architecture: local MCP tools in this agent):
 * - scan_whatsapp_jobs — exports and/or config.json-scoped pipeline + dedupe
 * - start_whatsapp_job_watcher — realtime whatsapp-web.js (listen-only)
 * - request_job_telegram_approval — Telegram Approve/Reject
 * - resolve_job_approval — record Approve/Reject
 * - submit_job_form — Playwright forms only after approval
 * - submit_whatsapp_job_cv — local draft package + mailto (legacy/helper)
 */

export const MCP_TOOLS = [
  {
    name: 'dispatch_coding_task',
    description:
      'Dispatches a software development/coding task to Cursor Agent CLI in headless mode.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description: 'Absolute path to the project / workspace to modify.',
        },
        taskDescription: {
          type: 'string',
          description: 'Full description of the coding task to execute.',
        },
      },
      required: ['projectPath', 'taskDescription'],
    },
  },
  {
    name: 'scan_whatsapp_jobs',
    description:
      'Scans WhatsApp jobs (Full Stack/Backend HE/EN). Uses config.json group allow-list + local DB dedupe when pipeline=true; otherwise reads Export chat .txt files. Never sends WhatsApp messages.',
    inputSchema: {
      type: 'object',
      properties: {
        exportPath: {
          type: 'string',
          description:
            'Absolute path to a WhatsApp .txt export file or a directory of exports. Defaults to the agent whatsappExportsDir.',
        },
        groupNames: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional group name filters (substring match). Ignored when pipeline uses config.json allow-list.',
        },
        keywords: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional extra/override job keywords.',
        },
        roles: {
          type: 'array',
          items: { type: 'string' },
          description: 'Desired roles to boost relevance (e.g. Full Stack, Backend).',
        },
        since: {
          type: 'string',
          description: 'ISO date/time; ignore older messages.',
        },
        limit: {
          type: 'number',
          description: 'Max job matches to return (default 50).',
        },
        pipeline: {
          type: 'boolean',
          description:
            'When true, filter to config.json groups, Full Stack/Backend, dedupe in local DB, and enqueue Telegram approval (dry-run if no bot token).',
        },
        notifyTelegram: {
          type: 'boolean',
          description: 'With pipeline=true, send Telegram Approve/Reject (default true).',
        },
        configPath: {
          type: 'string',
          description: 'Path to config.json (default: workspace root config.json).',
        },
      },
      required: [],
    },
  },
  {
    name: 'start_whatsapp_job_watcher',
    description:
      'Starts realtime whatsapp-web.js listen-only watcher for groups listed in config.json. Never sends WhatsApp messages. Text-only.',
    inputSchema: {
      type: 'object',
      properties: {
        configPath: {
          type: 'string',
          description: 'Path to config.json',
        },
        dryRun: {
          type: 'boolean',
          description: 'When true, validate config and return without connecting.',
        },
      },
      required: [],
    },
  },
  {
    name: 'request_job_telegram_approval',
    description:
      'Re-scan/enqueue or notify Telegram with Approve/Reject buttons for a job already in the local DB. Mandatory human approval before Playwright submit.',
    inputSchema: {
      type: 'object',
      properties: {
        configPath: { type: 'string' },
        exportPath: { type: 'string' },
        limit: { type: 'number' },
        dryRun: { type: 'boolean' },
      },
      required: [],
    },
  },
  {
    name: 'resolve_job_approval',
    description:
      'Records Telegram Approve or Reject for a job id (from callback_data job_approve:<id> / job_reject:<id>).',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string' },
        action: { type: 'string', description: 'approve | reject' },
        callbackData: {
          type: 'string',
          description: 'Raw Telegram callback_data (alternative to jobId+action).',
        },
        configPath: { type: 'string' },
      },
      required: [],
    },
  },
  {
    name: 'submit_job_form',
    description:
      'Fills an external apply form with Playwright after Telegram Approve. Uses profile (name, email, phone, linkedin, github) + assets/cv.pdf + LLM/template cover letter. Never WhatsApp DM/reply. Alerts Telegram on failure.',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: 'Approved job id from local DB' },
        configPath: { type: 'string' },
        profilePath: { type: 'string' },
        cvPath: { type: 'string' },
        coverNote: { type: 'string' },
        dryRun: {
          type: 'boolean',
          description: 'Validate + record dry run without launching browser',
        },
        skipDelay: {
          type: 'boolean',
          description: 'Skip configured delay between submissions (tests)',
        },
      },
      required: ['jobId'],
    },
  },
  {
    name: 'submit_whatsapp_job_cv',
    description:
      'Drafts a CV application for a WhatsApp-discovered job (local package + mailto). Does not send live WhatsApp messages; set confirm=true only after user approval. Prefer submit_job_form after Telegram Approve for Playwright forms.',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: {
          type: 'string',
          description: 'Optional job id from a prior scan_whatsapp_jobs result.',
        },
        jobText: {
          type: 'string',
          description: 'Full job post text (used to extract email/phone/URL).',
        },
        groupName: {
          type: 'string',
          description: 'WhatsApp group name for the application record.',
        },
        author: {
          type: 'string',
          description: 'Post author / recruiter name.',
        },
        recipientEmail: {
          type: 'string',
          description: 'Override recipient email if not present in jobText.',
        },
        coverNote: {
          type: 'string',
          description: 'Optional custom cover note; otherwise profile template is used.',
        },
        profilePath: {
          type: 'string',
          description: 'Path to candidate CV profile JSON. Defaults to CV_PROFILE_PATH / fixture.',
        },
        cvPath: {
          type: 'string',
          description: 'Override path to the CV file to attach.',
        },
        confirm: {
          type: 'boolean',
          description:
            'When true, mark draft ready_to_send after user approval (still no live send).',
        },
      },
      required: [],
    },
  },
  {
    name: 'redeploy_joinup_staging',
    description:
      'Redeploys the joinUp API staging service on Render (my-app-staging-ijyp) via Deploy Hook, then watches /api/health until healthy or timeout. Use when the user asks to restart/redeploy staging, or after server changes need a live staging refresh. Requires RENDER_STAGING_DEPLOY_HOOK_URL in .env. Does not touch production.',
    inputSchema: {
      type: 'object',
      properties: {
        force: {
          type: 'boolean',
          description:
            'When true (default), trigger redeploy even if no local server/ git changes were detected.',
        },
        waitMs: {
          type: 'number',
          description: 'Max ms to wait for staging health (default from JOINUP_STAGING_WAIT_MS).',
        },
      },
      required: [],
    },
  },
  {
    name: 'submit_manual_job_link',
    description: 'Submits a job application using Playwright given a direct URL.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' }
      },
      required: ['url']
    }
  }
];

export function getMcpTool(name) {
  return MCP_TOOLS.find((t) => t.name === name) || null;
}

export async function listMcpTools() {
  const localTools = MCP_TOOLS.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  }));
  // Ensure GDrive MCP is fully initialized before returning the tool list.
  try {
    await initGdriveMcp();
  } catch (err) {
    console.error('[mcp-tools] Error initializing GDrive MCP tools during listMcpTools:', err);
  }
  return [...localTools, ...getGdriveTools()];
}

/**
 * Execute a registered MCP tool by name.
 * @returns {{ ok: boolean, tool: string, result?: object, error?: string }}
 */
export async function executeMcpTool(name, args = {}, { onLog, signal } = {}) {
  const tool = getMcpTool(name);
  const isGdrive = name.startsWith('gdrive_');
  if (!tool && !isGdrive) {
    const err = new Error(`Unknown MCP tool: ${name}`);
    err.code = 'MCP_UNKNOWN_TOOL';
    throw err;
  }

  if (isGdrive) {
    // Ensure initialized lazily if not done at startup
    await initGdriveMcp(onLog);
    return executeGdriveTool(name, args, { onLog });
  }

  if (name === 'dispatch_coding_task') {
    return executeDispatchCodingTask(args, { onLog, signal });
  }
  if (name === 'scan_whatsapp_jobs') {
    return executeScanWhatsappJobs(args, { onLog });
  }
  if (name === 'start_whatsapp_job_watcher') {
    return executeStartWhatsappWatcher(args, { onLog });
  }
  if (name === 'request_job_telegram_approval') {
    return executeRequestTelegramApproval(args, { onLog });
  }
  if (name === 'resolve_job_approval') {
    return executeResolveJobApproval(args, { onLog });
  }
  if (name === 'submit_job_form') {
    return executeSubmitJobForm(args, { onLog });
  }
  if (name === 'submit_whatsapp_job_cv') {
    return executeSubmitWhatsappJobCv(args, { onLog });
  }
  if (name === 'submit_manual_job_link') {
    return executeSubmitManualJobLink(args, { onLog });
  }
  if (name === 'redeploy_joinup_staging') {
    return executeRedeployJoinupStaging(args, { onLog });
  }

  const err = new Error(`MCP tool not implemented: ${name}`);
  err.code = 'MCP_NOT_IMPLEMENTED';
  throw err;
}

async function executeRedeployJoinupStaging(args = {}, { onLog } = {}) {
  const { redeployAndWatchStaging, formatStagingTelegramLines } = await import(
    './joinup-telegram/render-staging.js'
  );
  const { recordActivity } = await import('./activity-store.js');

  const force = args.force !== false && args.force !== '0';
  const waitMs = Number(args.waitMs || process.env.JOINUP_STAGING_WAIT_MS || 420000);
  onLog?.(
    `[mcp] tool=redeploy_joinup_staging force=${force} waitMs=${waitMs}`
  );

  recordActivity({
    activityId: `staging-redeploy:${new Date().toISOString()}`,
    kind: 'status',
    source: 'mcp',
    platform: 'cursor',
    actorLabel: 'Voice agent MCP',
    title: 'Redeploy joinUp staging',
    text: `Starting Render staging redeploy (force=${force})`,
    project: process.env.JOINUP_PROJECT_ROOT || '',
  });

  const staging = await redeployAndWatchStaging({
    force,
    onLog,
    timeoutMs: Number.isFinite(waitMs) ? waitMs : 420000,
  });

  const lines = formatStagingTelegramLines(staging);
  onLog?.(lines.join('\n'));

  recordActivity({
    activityId: `staging-redeploy:${staging.stagingUrl || 'staging'}`,
    kind: staging.ok || staging.skipped ? 'run_end' : 'error',
    source: 'mcp',
    platform: 'cursor',
    actorLabel: 'Voice agent MCP',
    title: 'Redeploy joinUp staging',
    text: lines.join('\n'),
    project: process.env.JOINUP_PROJECT_ROOT || '',
    meta: {
      ok: staging.ok,
      skipped: !!staging.skipped,
      stagingUrl: staging.stagingUrl || '',
    },
  });

  if (!staging.ok && !staging.skipped) {
    return {
      ok: false,
      tool: 'redeploy_joinup_staging',
      error: (staging.errors || []).join('; ') || 'Staging redeploy/health failed',
      staging,
      summary: lines.join('\n'),
    };
  }

  return {
    ok: true,
    tool: 'redeploy_joinup_staging',
    staging,
    summary: lines.join('\n'),
  };
}

async function executeDispatchCodingTask(args, { onLog, signal } = {}) {
  const { remapCodingProjectPath, resolveCodingProjectRoot } = await import(
    './workspaces.js'
  );
  const rawPath = String(args.projectPath || '').trim();
  const projectPath = remapCodingProjectPath(
    rawPath || resolveCodingProjectRoot({ text: String(args.taskDescription || '') })
  );
  const taskDescription = String(args.taskDescription || '').trim();
  if (!taskDescription) {
    const err = new Error('dispatch_coding_task requires taskDescription');
    err.code = 'MCP_INVALID_ARGS';
    throw err;
  }

  const scriptPath = resolveDispatchScript();
  const dispatchCmd = [
    'node',
    scriptPath,
    '--project',
    projectPath,
    '--task',
    taskDescription,
  ];

  onLog?.(
    `[mcp] tool=dispatch_coding_task calling: ${dispatchCmd
      .map((a) => (/\s/.test(a) ? JSON.stringify(a) : a))
      .join(' ')}`
  );
  onLog?.(
    `[mcp] tool=dispatch_coding_task args=${JSON.stringify({
      projectPath,
      taskDescription: taskDescription.slice(0, 200),
    })}`
  );

  let result;
  try {
    result = await runDispatchTask(
      { project: projectPath, task: taskDescription },
      { onLog, signal }
    );
  } catch (err) {
    if (err?.code === 'CLI_AUTH_REQUIRED' || err?.code === 'CLI_AUTH_TIMEOUT') {
      onLog?.(
        `[mcp] tool=dispatch_coding_task status=${err.code} tool=${err.tool || 'cursor'}`
      );
      return {
        ok: false,
        tool: 'dispatch_coding_task',
        code: err.code,
        projectPath,
        taskDescription,
        authTool: err.tool || 'cursor',
        authUrl: err.authUrl || '',
        queueId: err.queueId || '',
        error: err.message,
        summary:
          'Cursor CLI is not authenticated on this host. ' +
          'Open the auth URL (or run `npm run auth:cursor`), then POST /api/cli-auth/retry.',
      };
    }
    throw err;
  }

  onLog?.(`[mcp] tool=dispatch_coding_task status=ok exit=${result.code ?? 0}`);

  return {
    ok: true,
    tool: 'dispatch_coding_task',
    projectPath,
    taskDescription,
    result,
  };
}

async function executeScanWhatsappJobs(args = {}, { onLog } = {}) {
  if (args.pipeline) {
    const exportPath =
      String(args.exportPath || '').trim() || config.whatsappExportsDir;
    let scanPath = exportPath;
    if (
      !fs.existsSync(scanPath) ||
      (fs.statSync(scanPath).isDirectory() &&
        resolveExportTxtCount(scanPath) === 0)
    ) {
      scanPath = config.whatsappFixturePath;
      onLog?.(
        `[mcp] tool=scan_whatsapp_jobs pipeline empty exports; using fixture ${scanPath}`
      );
    }
    onLog?.(
      `[mcp] tool=scan_whatsapp_jobs pipeline=true exportPath=${scanPath}`
    );
    const result = await scanAndEnqueueJobs({
      configPath: args.configPath,
      exportPath: scanPath,
      notifyTelegram: args.notifyTelegram !== false,
      dryRunTelegram: true,
      limit: args.limit != null ? Number(args.limit) : 50,
      onLog,
    });
    onLog?.(
      `[mcp] tool=scan_whatsapp_jobs status=ok pipeline jobs=${result.enqueuedCount} dupes=${result.duplicateCount}`
    );
    return {
      ok: true,
      tool: 'scan_whatsapp_jobs',
      pipeline: true,
      exportPath: scanPath,
      jobCount: result.enqueuedCount,
      jobs: result.jobs,
      ...result,
    };
  }

  const exportPath =
    String(args.exportPath || '').trim() || config.whatsappExportsDir;

  const mcpArgs = {
    exportPath,
    groupNames: Array.isArray(args.groupNames) ? args.groupNames : undefined,
    keywords: Array.isArray(args.keywords) ? args.keywords : undefined,
    roles: Array.isArray(args.roles) ? args.roles : undefined,
    since: args.since ? String(args.since) : undefined,
    limit: args.limit != null ? Number(args.limit) : undefined,
  };

  onLog?.(
    `[mcp] tool=scan_whatsapp_jobs args=${JSON.stringify({
      exportPath: mcpArgs.exportPath,
      groupNames: mcpArgs.groupNames,
      roles: mcpArgs.roles,
      since: mcpArgs.since,
      limit: mcpArgs.limit,
    })}`
  );

  let scanPath = mcpArgs.exportPath;
  try {
    const result = scanWhatsappJobs({ ...mcpArgs, exportPath: scanPath });
    if (
      result.scannedFiles === 0 &&
      path.resolve(scanPath) === path.resolve(config.whatsappExportsDir)
    ) {
      scanPath = config.whatsappFixturePath;
      onLog?.(
        `[mcp] tool=scan_whatsapp_jobs empty exports dir; using fixture ${scanPath}`
      );
      const fixtureResult = scanWhatsappJobs({ ...mcpArgs, exportPath: scanPath });
      onLog?.(
        `[mcp] tool=scan_whatsapp_jobs status=ok jobs=${fixtureResult.jobCount} files=${fixtureResult.scannedFiles}`
      );
      return {
        ok: true,
        tool: 'scan_whatsapp_jobs',
        exportPath: scanPath,
        usedFixture: true,
        ...fixtureResult,
      };
    }
    onLog?.(
      `[mcp] tool=scan_whatsapp_jobs status=ok jobs=${result.jobCount} files=${result.scannedFiles}`
    );
    return {
      ok: true,
      tool: 'scan_whatsapp_jobs',
      exportPath: scanPath,
      usedFixture: false,
      ...result,
    };
  } catch (err) {
    if (
      err.code === 'WA_EXPORT_NOT_FOUND' &&
      path.resolve(String(args.exportPath || config.whatsappExportsDir)) ===
        path.resolve(config.whatsappExportsDir)
    ) {
      scanPath = config.whatsappFixturePath;
      onLog?.(
        `[mcp] tool=scan_whatsapp_jobs exports missing; using fixture ${scanPath}`
      );
      const fixtureResult = scanWhatsappJobs({ ...mcpArgs, exportPath: scanPath });
      onLog?.(
        `[mcp] tool=scan_whatsapp_jobs status=ok jobs=${fixtureResult.jobCount} files=${fixtureResult.scannedFiles}`
      );
      return {
        ok: true,
        tool: 'scan_whatsapp_jobs',
        exportPath: scanPath,
        usedFixture: true,
        ...fixtureResult,
      };
    }
    onLog?.(`[mcp] tool=scan_whatsapp_jobs status=error ${err.message}`);
    throw err;
  }
}

function resolveExportTxtCount(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => /\.txt$/i.test(f)).length;
  } catch {
    return 0;
  }
}

async function executeStartWhatsappWatcher(args = {}, { onLog } = {}) {
  const jobsConfig = loadJobsConfig(args.configPath);
  onLog?.(
    `[mcp] tool=start_whatsapp_job_watcher groups=${jobsConfig.whatsapp.groups.join(', ')}`
  );
  // Default dryRun=true — avoids QR prompts unless explicitly dryRun=false.
  if (args.dryRun !== false) {
    onLog?.(
      `[mcp] tool=start_whatsapp_job_watcher status=ok dryRun=true (listen-only; never send)`
    );
    return {
      ok: true,
      tool: 'start_whatsapp_job_watcher',
      dryRun: true,
      groups: jobsConfig.whatsapp.groups,
      textOnly: jobsConfig.whatsapp.textOnly,
      neverSendMessages: true,
      note: 'Pass dryRun=false to start the shared HTTP WhatsApp session (one Chrome). Live ingest is already attached on ready.',
    };
  }

  const { getSharedWhatsappSession } = await import('./whatsapp/session.js');
  const session = getSharedWhatsappSession();
  const snap = await session.start();
  onLog?.('[mcp] tool=start_whatsapp_job_watcher status=ok sharedSession=true');
  return {
    ok: true,
    tool: 'start_whatsapp_job_watcher',
    dryRun: false,
    sharedSession: true,
    groups: jobsConfig.whatsapp.groups,
    whatsapp: snap,
    note: 'Using the shared voice-agent WhatsApp session (no second Chrome). Jobs persist via jobs-engine ingest (Mongo + Telegram).',
  };
}

async function executeRequestTelegramApproval(args = {}, { onLog } = {}) {
  const exportPath =
    String(args.exportPath || '').trim() ||
    (fs.existsSync(config.whatsappExportsDir) &&
    resolveExportTxtCount(config.whatsappExportsDir) > 0
      ? config.whatsappExportsDir
      : config.whatsappFixturePath);

  onLog?.(
    `[mcp] tool=request_job_telegram_approval exportPath=${exportPath}`
  );
  const result = await scanAndEnqueueJobs({
    configPath: args.configPath,
    exportPath,
    notifyTelegram: true,
    dryRunTelegram: args.dryRun !== false,
    limit: args.limit != null ? Number(args.limit) : 20,
    onLog,
  });
  onLog?.(
    `[mcp] tool=request_job_telegram_approval status=ok enqueued=${result.enqueuedCount}`
  );
  return { ok: true, tool: 'request_job_telegram_approval', ...result };
}

function executeResolveJobApproval(args = {}, { onLog } = {}) {
  onLog?.(
    `[mcp] tool=resolve_job_approval args=${JSON.stringify({
      jobId: args.jobId,
      action: args.action,
      callbackData: args.callbackData,
    })}`
  );
  const result = resolveJobApproval({
    configPath: args.configPath,
    jobId: args.jobId,
    action: args.action,
    callbackData: args.callbackData,
    onLog,
  });
  onLog?.(
    `[mcp] tool=resolve_job_approval status=ok action=${result.action} job=${result.job.id}`
  );
  return { ok: true, tool: 'resolve_job_approval', ...result };
}

async function executeSubmitJobForm(args = {}, { onLog } = {}) {
  const jobId = String(args.jobId || '').trim();
  if (!jobId) {
    const err = new Error('submit_job_form requires jobId');
    err.code = 'MCP_INVALID_ARGS';
    throw err;
  }
  onLog?.(
    `[mcp] tool=submit_job_form jobId=${jobId} dryRun=${Boolean(args.dryRun)}`
  );
  try {
    const result = await submitApprovedJob({
      configPath: args.configPath,
      jobId,
      profilePath: args.profilePath,
      cvPath: args.cvPath,
      coverNote: args.coverNote,
      dryRun: Boolean(args.dryRun),
      skipDelay: args.skipDelay !== false || Boolean(args.dryRun),
      onLog,
    });
    onLog?.(
      `[mcp] tool=submit_job_form status=ok application=${result.application?.id}`
    );
    return { ok: true, tool: 'submit_job_form', ...result };
  } catch (err) {
    onLog?.(`[mcp] tool=submit_job_form status=error ${err.message}`);
    throw err;
  }
}

function resolveCvProfilePath(explicitPath) {
  const requested = String(explicitPath || '').trim();
  if (requested) {
    if (!fs.existsSync(requested)) {
      const err = new Error(`CV profile not found: ${requested}`);
      err.code = 'CV_PROFILE_NOT_FOUND';
      throw err;
    }
    return requested;
  }
  if (fs.existsSync(config.cvProfilePath)) return config.cvProfilePath;
  return config.cvFixtureProfilePath;
}

function executeSubmitWhatsappJobCv(args = {}, { onLog } = {}) {
  const profilePath = resolveCvProfilePath(args.profilePath);
  const mcpArgs = {
    jobId: args.jobId != null ? String(args.jobId) : undefined,
    jobText: args.jobText != null ? String(args.jobText) : '',
    groupName: args.groupName != null ? String(args.groupName) : '',
    author: args.author != null ? String(args.author) : '',
    recipientEmail: args.recipientEmail
      ? String(args.recipientEmail).trim()
      : undefined,
    coverNote: args.coverNote != null ? String(args.coverNote) : undefined,
    profilePath,
    applicationsDir: config.cvApplicationsDir,
    cvPath: args.cvPath ? String(args.cvPath).trim() : undefined,
    confirm: Boolean(args.confirm),
  };

  onLog?.(
    `[mcp] tool=submit_whatsapp_job_cv args=${JSON.stringify({
      jobId: mcpArgs.jobId,
      groupName: mcpArgs.groupName,
      author: mcpArgs.author,
      recipientEmail: mcpArgs.recipientEmail,
      profilePath: mcpArgs.profilePath,
      confirm: mcpArgs.confirm,
      jobTextLen: mcpArgs.jobText.length,
    })}`
  );

  try {
    const result = submitWhatsappJobCv(mcpArgs);
    onLog?.(
      `[mcp] tool=submit_whatsapp_job_cv status=ok application=${result.application.id} state=${result.application.status}`
    );
    return {
      ok: true,
      tool: 'submit_whatsapp_job_cv',
      usedFixtureProfile:
        path.resolve(profilePath) === path.resolve(config.cvFixtureProfilePath),
      ...result,
    };
  } catch (err) {
    onLog?.(`[mcp] tool=submit_whatsapp_job_cv status=error ${err.message}`);
    throw err;
  }
}

import { randomUUID } from 'node:crypto';
import { openJobDb } from './jobs/job-db.js';
import { updateJobInTracker } from './jobs/tracker.js';

async function executeSubmitManualJobLink(args = {}, { onLog } = {}) {
  const url = String(args.url || '').trim();
  if (!url) throw new Error('URL is required');

  onLog?.(`[mcp] tool=submit_manual_job_link url=${url}`);
  
  const db = openJobDb(path.join(config.root, 'data', 'jobs-db.json'));
  const jobId = `manual_${randomUUID().slice(0, 8)}`;
  
  const mockJob = {
    id: jobId,
    groupName: 'Manual URL Submission',
    author: 'User',
    body: `Manual submission to: ${url}`,
    text: `Manual submission to: ${url}`,
    timestamp: new Date().toISOString(),
    status: 'approved',
    approvalStatus: 'approved',
    formUrl: url
  };
  
  const { job: upsertedJob } = db.upsertJob(mockJob);
  const actualJobId = upsertedJob.id;
  
  // Force approval status in case it was deduplicated from a previous pending attempt
  db.update(actualJobId, { approvalStatus: 'approved' });
  
  onLog?.(`[mcp] injected/updated manual job id=${actualJobId} into tracker`);

  try {
    const result = await submitApprovedJob({
      configPath: path.join(config.root, 'config.json'),
      jobId: actualJobId,
      onLog
    });
    return { ok: true, tool: 'submit_manual_job_link', url, result };
  } catch (err) {
    onLog?.(`[mcp] tool=submit_manual_job_link error: ${err.message}`);
    throw err;
  }
}
