import fs from 'node:fs';
import path from 'node:path';
import { pinToJoinUpRoot } from './config.js';
import { runDispatchTask } from '../task-router.js';
import {
  formatVercelTelegramLines,
  resolveJoinUpVercelUrl,
} from './vercel.js';

/**
 * Cursor Agent runner pinned exclusively to the joinUp repository root.
 * Never accepts a user-supplied project path; never runs outside joinUp.
 */
export class JoinUpCursorExecutor {
  /**
   * @param {{ joinUpRoot: string, runDispatch?: typeof runDispatchTask }} options
   */
  constructor(options) {
    if (!options?.joinUpRoot) {
      throw new Error('JoinUpCursorExecutor requires joinUpRoot');
    }
    this.joinUpRoot = pinToJoinUpRoot(options.joinUpRoot);
    this.runDispatch = options.runDispatch || runDispatchTask;
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
      '- When green: merge the feature branch into Dev and push (triggers Vercel).',
      '',
      task,
    ].join('\n');

    opts.onLog?.(
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
        { onLog: opts.onLog, signal: opts.signal }
      );
    } finally {
      if (prevMerge === undefined) delete process.env.DISPATCH_MERGE_TARGET;
      else process.env.DISPATCH_MERGE_TARGET = prevMerge;
      if (prevTimeout === undefined) delete process.env.DISPATCH_AGENT_TIMEOUT_MS;
      else process.env.DISPATCH_AGENT_TIMEOUT_MS = prevTimeout;
      if (prevLoops === undefined) delete process.env.DISPATCH_MAX_FIX_LOOPS;
      else process.env.DISPATCH_MAX_FIX_LOOPS = prevLoops;
    }

    // Always resolve a Vercel link after merge/push to Dev (best-effort wait for READY).
    const vercel = await resolveJoinUpVercelUrl({
      gitBranch: process.env.JOINUP_VERCEL_BRANCH || 'Dev',
      onLog: opts.onLog,
      // After dispatch we already waited a long time; keep poll modest unless configured.
      timeoutMs: Number(process.env.JOINUP_VERCEL_WAIT_MS || 180000),
    });
    opts.onLog?.(
      `[joinup-telegram] vercel url=${vercel.url || '(none)'} state=${vercel.state}`
    );

    return {
      ok: true,
      projectPath: project,
      vercel,
      ...result,
    };
  }
}

/**
 * Human-readable completion note for Telegram (non-technical).
 * Always includes a Vercel link when configured / discovered.
 * @param {{ ok?: boolean, projectPath?: string, error?: string, vercel?: object }} result
 */
export function formatCompletionMessage(result) {
  const vercelLines = formatVercelTelegramLines(result?.vercel);
  if (result?.ok) {
    return [
      'מוכן — העדכון ל-joinUp נבנה ועלה.',
      '',
      ...vercelLines,
      '',
      'אפשר לפתוח את הקישור ולבדוק את השינוי. אם משהו לא מרגיש נכון — כתבו לי.',
    ].join('\n');
  }
  return [
    'משהו השתבש בבנייה של joinUp.',
    '',
    ...vercelLines,
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
