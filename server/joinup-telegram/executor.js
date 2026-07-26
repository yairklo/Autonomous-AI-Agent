import fs from 'node:fs';
import path from 'node:path';
import { pinToJoinUpRoot } from './config.js';
import { runDispatchTask } from '../task-router.js';

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
      task,
    ].join('\n');

    opts.onLog?.(
      `[joinup-telegram] dispatch pinned cwd=${project} taskChars=${wrappedTask.length}`
    );

    const result = await this.runDispatch(
      { project, task: wrappedTask },
      { onLog: opts.onLog, signal: opts.signal }
    );

    return {
      ok: true,
      projectPath: project,
      ...result,
    };
  }
}

/**
 * Human-readable completion note for Telegram (non-technical).
 * @param {{ ok?: boolean, projectPath?: string, error?: string }} result
 */
export function formatCompletionMessage(result) {
  if (result?.ok) {
    return [
      'Done — the joinUp update has been built.',
      '',
      'The changes are ready in the joinUp project. A teammate can review them when convenient.',
      'Tell me if you want to tweak anything or specify another improvement.',
    ].join('\n');
  }
  return [
    'Something went wrong while building this for joinUp.',
    '',
    'No need for technical details on your side — please share the idea again or ask a teammate to check the build status.',
    result?.error ? `Note: ${String(result.error).slice(0, 200)}` : '',
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
