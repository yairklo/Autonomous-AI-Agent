import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { config } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Resolve dispatch-task.js at call time so tests can stub via DISPATCH_TASK_SCRIPT. */
export function resolveDispatchScript() {
  return process.env.DISPATCH_TASK_SCRIPT
    ? path.resolve(process.env.DISPATCH_TASK_SCRIPT)
    : path.join(config.root, 'scripts', 'dispatch-task.js');
}

/**
 * True when the user explicitly opts out of Grill-Me Mode or orders an immediate dispatch.
 * Ordinary coding requests without this signal stay in Grill-Me Mode (Claude asks questions).
 */
export function wantsSkipGrillMe(text) {
  const cleaned = String(text || '').trim();
  if (!cleaned) return false;

  return (
    /skip\s+grill-?me(\s+mode)?/i.test(cleaned) ||
    /דלג\s+על\s+grill-?me(\s+mode)?/i.test(cleaned) ||
    /grill-?me\s+mode\s+off/i.test(cleaned) ||
    /שגר\s*(את\s*)?(המשימה\s*)?(ישירות\s*)?(ל-?\s*)?cursor/i.test(cleaned) ||
    /dispatch\s+(this|it|the\s+task|now|directly)?\s*(to\s+)?cursor/i.test(cleaned) ||
    /dispatch\s+to\s+cursor/i.test(cleaned) ||
    /invoke\s+dispatch_coding_task/i.test(cleaned) ||
    /call\s+dispatch_coding_task/i.test(cleaned)
  );
}

/**
 * Short confirmations after a Grill-Me dialogue (need session-refined task text).
 */
export function isShortDispatchConfirmation(text) {
  const cleaned = String(text || '').trim();
  if (!cleaned || cleaned.length > 320) return false;
  if (!wantsSkipGrillMe(cleaned)) return false;
  // Full task bodies usually include implementation verbs + project cues.
  const looksLikeFullTask =
    /(implement|refactor|fix|create|build|תוסיף|הוסף|תקן|בנה)/i.test(cleaned) &&
    /(project|פרויקט|header|\.js|\.ts|\.tsx|repo|mcp|path:|C:\/|\/)/i.test(cleaned);
  return !looksLikeFullTask;
}

/**
 * Detect explicit coding / Cursor-dispatch intent (skip Grill-Me or confirm dispatch).
 * Used by the Claude orchestration layer to invoke the dispatch_coding_task MCP tool.
 * Returns null for ordinary interactive coding requests so Grill-Me Mode can run.
 */
export function detectCodingDispatch(text) {
  const cleaned = String(text || '').trim();
  if (!cleaned) return null;

  if (!wantsSkipGrillMe(cleaned)) return null;

  const project = extractProjectPath(cleaned) || config.root;
  const resolvedProject = fs.existsSync(project) ? project : config.root;

  return {
    project: resolvedProject,
    task: cleaned,
    dispatchScript: resolveDispatchScript(),
    skipGrillMe: true,
    shortConfirmation: isShortDispatchConfirmation(cleaned),
    /** MCP tool args Claude / orchestration must use for coding work */
    mcpTool: 'dispatch_coding_task',
    mcpArgs: {
      projectPath: resolvedProject,
      taskDescription: cleaned,
    },
  };
}

function extractProjectPath(text) {
  const quoted = text.match(/["']([A-Za-z]:[^"']+|\/[^"']+)["']/);
  if (quoted?.[1] && fs.existsSync(quoted[1].trim())) {
    return path.resolve(quoted[1].trim());
  }

  // Windows path: stop before non-ASCII / sentence punctuation clusters
  const win = text.match(/([A-Za-z]:[\\/][A-Za-z0-9 _.\-\\/]+)/);
  if (win?.[1]) {
    const candidate = win[1].replace(/[.\s]+$/g, '').trim();
    if (fs.existsSync(candidate)) return path.resolve(candidate);
    // Try progressively shorter prefixes (handle "Agent. more text")
    const parts = candidate.split(/[\\/]/);
    while (parts.length > 1) {
      const p = parts.join(path.sep);
      if (fs.existsSync(p)) return path.resolve(p);
      parts.pop();
    }
  }

  const unix = text.match(/(?:^|\s)((?:\/|\.\/)[A-Za-z0-9 _.\-\/]+)/);
  if (unix?.[1]) {
    const candidate = unix[1].replace(/[.\s]+$/g, '').trim();
    if (fs.existsSync(candidate)) return path.resolve(candidate);
  }

  return null;
}

/**
 * Run scripts/dispatch-task.js and stream stdout/stderr lines via onLog.
 * Invoked only via the dispatch_coding_task MCP tool — not as a raw shell from Claude.
 */
export function runDispatchTask({ project, task }, { onLog, signal } = {}) {
  return new Promise((resolve, reject) => {
    const script = resolveDispatchScript();
    const args = [script, '--project', project, '--task', task];
    onLog?.(`[dispatch] node ${args.map(JSON.stringify).join(' ')}`);

    const child = spawn(process.execPath, args, {
      cwd: config.root,
      env: {
        ...process.env,
        // Prefer a reliable headless runner for automation; Claude/Cursor CLI still tried first in auto mode.
        DISPATCH_AGENT: process.env.DISPATCH_AGENT || 'auto',
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const onAbort = () => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      for (const line of text.split(/\r?\n/).filter(Boolean)) onLog?.(line);
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      for (const line of text.split(/\r?\n/).filter(Boolean)) onLog?.(`[stderr] ${line}`);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (code === 0) {
        resolve({ ok: true, stdout, stderr, code });
      } else {
        const err = new Error(
          `dispatch-task.js exited with code ${code}: ${(stderr || stdout).slice(-800)}`
        );
        err.code = code;
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      }
    });
  });
}
