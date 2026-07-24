import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { config } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dispatchScript = path.join(config.root, 'scripts', 'dispatch-task.js');

/**
 * Detect coding / Cursor-dispatch intent in a user utterance.
 * Used by the Claude orchestration layer to hand work to dispatch-task.js.
 */
export function detectCodingDispatch(text) {
  const cleaned = String(text || '').trim();
  if (!cleaned) return null;

  const wantsDispatch =
    /שגר|dispatch|grill-?me|cursor\s*cli|headless|סוכן|agent mode/i.test(cleaned) ||
    (/(תוסיף|הוסף|add|implement|refactor|fix|create|build)/i.test(cleaned) &&
      /(פרויקט|project|header|כפתור|button|\.js|\.ts|\.tsx|repo)/i.test(cleaned));

  if (!wantsDispatch) return null;

  const project = extractProjectPath(cleaned) || config.root;
  if (!fs.existsSync(project)) {
    return {
      project: config.root,
      task: cleaned,
      dispatchScript,
    };
  }

  return {
    project,
    task: cleaned,
    dispatchScript,
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
 */
export function runDispatchTask({ project, task }, { onLog, signal } = {}) {
  return new Promise((resolve, reject) => {
    const args = [dispatchScript, '--project', project, '--task', task];
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
