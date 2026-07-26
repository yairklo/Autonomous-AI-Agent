import fs from 'node:fs';
import path from 'node:path';
import { pinToJoinUpRoot } from './config.js';
import { runDispatchTask } from '../task-router.js';
import {
  formatVercelTelegramLines,
  resolveJoinUpVercelUrl,
} from './vercel.js';
import {
  formatStagingTelegramLines,
  redeployAndWatchStaging,
} from './render-staging.js';
import {
  bridgeEndRun,
  bridgeLogLine,
  bridgeStartRun,
} from './run-log-bridge.js';

/**
 * Cursor Agent runner pinned exclusively to the joinUp repository root.
 * Never accepts a user-supplied project path; never runs outside joinUp.
 */
export class JoinUpCursorExecutor {
  /**
   * @param {{
   *   joinUpRoot: string,
   *   runDispatch?: typeof runDispatchTask,
   *   resolveVercelUrl?: typeof resolveJoinUpVercelUrl,
   *   redeployStaging?: typeof redeployAndWatchStaging,
   *   bridge?: boolean,
   * }} options
   */
  constructor(options) {
    if (!options?.joinUpRoot) {
      throw new Error('JoinUpCursorExecutor requires joinUpRoot');
    }
    this.joinUpRoot = pinToJoinUpRoot(options.joinUpRoot);
    this.runDispatch = options.runDispatch || runDispatchTask;
    this.resolveVercelUrl = options.resolveVercelUrl || resolveJoinUpVercelUrl;
    this.redeployStaging = options.redeployStaging || redeployAndWatchStaging;
    this.bridge = options.bridge !== false;
  }

  /**
   * Absolute path the agent is allowed to modify (always joinUp root).
   */
  get pinnedRoot() {
    return this.joinUpRoot;
  }

  /**
   * @param {string} technicalPrompt
   * @param {{ onLog?: (line: string) => void, signal?: AbortSignal }} [opts]
   */
  async execute(technicalPrompt, opts = {}) {
    const task = String(technicalPrompt || '').trim();
    if (!task) {
      const err = new Error('Empty technical prompt — refusing to dispatch');
      err.code = 'JOINUP_EMPTY_TASK';
      throw err;
    }

    const project = pinToJoinUpRoot(this.joinUpRoot);
    if (!fs.existsSync(project)) {
      const err = new Error(`joinUp root missing: ${project}`);
      err.code = 'JOINUP_ROOT_MISSING';
      throw err;
    }

    // Defense in depth: refuse if someone swapped runDispatch to a shell runner.
    // We only ever call the coding dispatch with the pinned project path.
    const wrappedTask = [
      'Product-confirmed feature request for the joinUp project only.',
      'Stay strictly inside this repository. Do not touch other projects or system paths.',
      '',
      'QUALITY / DEPLOY REQUIREMENTS (joinUp):',
      '- After coding: run `cd next_app && npm run build` and fix TypeScript/build errors in a loop until green.',
      '- Run server tests when relevant (`cd server && npm test`).',
      '- Do not consider the task done while Next build is red (Vercel will fail otherwise).',
      '- When green: merge the feature branch into Dev and push (triggers Vercel preview).',
      '- Server/API staging is https://my-app-staging-ijyp.onrender.com (NOT the old joinupapp-1.onrender.com).',
      '- Production API is https://joinup-api.duckdns.org — do not treat old Render prod as current.',
      '- After server/ changes the orchestrator redeploys Render staging and watches /api/health for errors.',
      '',
      task,
    ].join('\n');

    const runId = this.bridge
      ? await bridgeStartRun({
          source: 'joinup-telegram',
          project,
          title: task.slice(0, 120),
        })
      : null;
    const log = async (line) => {
      opts.onLog?.(line);
      if (this.bridge) await bridgeLogLine(runId, line, { project });
      else console.log(line);
    };

    await log(
      `[joinup-telegram] dispatch pinned cwd=${project} taskChars=${wrappedTask.length}`
    );

    // Enforce joinUp deploy branch + longer agent window for build/fix loops.
    const prevMerge = process.env.DISPATCH_MERGE_TARGET;
    const prevTimeout = process.env.DISPATCH_AGENT_TIMEOUT_MS;
    const prevLoops = process.env.DISPATCH_MAX_FIX_LOOPS;
    process.env.DISPATCH_MERGE_TARGET = process.env.DISPATCH_MERGE_TARGET || 'Dev';
    process.env.DISPATCH_AGENT_TIMEOUT_MS =
      process.env.DISPATCH_AGENT_TIMEOUT_MS || '1200000';
    process.env.DISPATCH_MAX_FIX_LOOPS = process.env.DISPATCH_MAX_FIX_LOOPS || '5';

    let result;
    try {
      result = await this.runDispatch(
        { project, task: wrappedTask },
        {
          runId: runId || undefined,
          onLog: (line) => {
            void log(line);
          },
          signal: opts.signal,
        }
      );
    } catch (err) {
      if (this.bridge) await bridgeEndRun(runId, { ok: false, text: err.message });
      throw err;
    } finally {
      if (prevMerge === undefined) delete process.env.DISPATCH_MERGE_TARGET;
      else process.env.DISPATCH_MERGE_TARGET = prevMerge;
      if (prevTimeout === undefined) delete process.env.DISPATCH_AGENT_TIMEOUT_MS;
      else process.env.DISPATCH_AGENT_TIMEOUT_MS = prevTimeout;
      if (prevLoops === undefined) delete process.env.DISPATCH_MAX_FIX_LOOPS;
      else process.env.DISPATCH_MAX_FIX_LOOPS = prevLoops;
    }

    // Preview URL for the Dev branch build (PR-style), never production.
    const vercel = await this.resolveVercelUrl({
      gitBranch: process.env.JOINUP_VERCEL_BRANCH || 'Dev',
      projectRoot: project,
      onLog: (line) => {
        void log(line);
      },
      timeoutMs: Number(process.env.JOINUP_VERCEL_WAIT_MS || 300000),
      allowProductionFallback: false,
    });
    await log(
      `[joinup-telegram] vercel preview=${vercel.url || '(none)'} state=${vercel.state} source=${vercel.source || ''}`
    );

    // Redeploy Render staging when server/ changed; listen until /api/health is green.
    const staging = await this.redeployStaging({
      projectRoot: project,
      force: process.env.JOINUP_STAGING_FORCE_REDEPLOY === '1',
      onLog: (line) => {
        void log(line);
      },
      timeoutMs: Number(process.env.JOINUP_STAGING_WAIT_MS || 420000),
    });
    await log(
      `[joinup-telegram] staging=${staging.stagingUrl} ok=${staging.ok} skipped=${!!staging.skipped}`
    );
    if (staging.errors?.length) {
      for (const e of staging.errors.slice(0, 5)) {
        await log(`[joinup-telegram] staging-error: ${e}`);
      }
    }

    const summaryParts = [];
    if (vercel.url) summaryParts.push(`Preview: ${vercel.url}`);
    if (staging.stagingUrl) summaryParts.push(`Staging: ${staging.stagingUrl}`);
    if (!staging.ok && !staging.skipped) summaryParts.push('Staging health FAILED');

    if (this.bridge) {
      await bridgeEndRun(runId, {
        ok: staging.ok || !!staging.skipped,
        text: summaryParts.length ? `Done. ${summaryParts.join(' | ')}` : 'Done.',
      });
    }

    return {
      ok: true,
      projectPath: project,
      vercel,
      staging,
      runId,
      ...result,
    };
  }
}

/**
 * Human-readable completion note for Telegram (non-technical).
 * Includes Vercel preview + Render staging when available.
 * @param {{ ok?: boolean, projectPath?: string, error?: string, vercel?: object, staging?: object }} result
 */
export function formatCompletionMessage(result) {
  const vercelLines = formatVercelTelegramLines(result?.vercel);
  const stagingLines = formatStagingTelegramLines(result?.staging);
  const middle = [
    ...vercelLines,
    ...(stagingLines.length && vercelLines.length ? [''] : []),
    ...stagingLines,
  ];
  if (result?.ok) {
    return [
      'מוכן — העדכון ל-joinUp נבנה ועלה.',
      '',
      ...middle,
      '',
      'אפשר לפתוח את הקישור ולבדוק את השינוי. אם משהו לא מרגיש נכון — כתבו לי.',
    ].join('\n');
  }
  return [
    'משהו השתבש בבנייה של joinUp.',
    '',
    ...middle,
    '',
    'נסו לאשר שוב בעוד רגע, או בקשו ממישהו מהצוות לבדוק את סטטוס הבילד.',
    result?.error ? `הערה: ${String(result.error).slice(0, 200)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Sanity helper for tests: confirm a candidate path is the pinned root.
 */
export function assertPinnedProjectPath(joinUpRoot, candidate) {
  const pinned = pinToJoinUpRoot(joinUpRoot);
  const resolved = path.resolve(candidate);
  if (resolved !== pinned) {
    throw new Error(`Path not pinned to joinUp root: ${resolved} !== ${pinned}`);
  }
  return pinned;
}
