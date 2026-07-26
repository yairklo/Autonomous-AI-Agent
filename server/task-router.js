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
 * True when the user wants an interactive dialogue with Claude in this chat
 * (Grill-Me Pack / "ask me questions") — NOT an automatic MCP tool or Cursor run.
 * Mentioning "Grill-Me", WhatsApp, or CV as conversation topics must not auto-fire tools.
 */
export function isInteractiveConversationRequest(text) {
  const cleaned = String(text || '').trim();
  if (!cleaned) return false;
  // Explicit skip / dispatch confirmation always wins.
  if (wantsSkipGrillMe(cleaned)) return false;

  return (
    /שאל\s+אותי|תשאל\s+אותי|ask\s+me\b|interview\s+me/i.test(cleaned) ||
    /grill-?me\s+pack/i.test(cleaned) ||
    /שאלות\s+מתוך|questions?\s+from\b/i.test(cleaned) ||
    /תשאל\s+שאלות|ask\s+(me\s+)?(clarifying\s+)?questions/i.test(cleaned) ||
    /בוא\s+נ(?:עשה|ריץ)\s+grill|let'?s\s+(do\s+)?grill/i.test(cleaned) ||
    (/\bgrill-?me\b/i.test(cleaned) &&
      /(איתי|with\s+me|שיחה|chat|conversation|תשאל|שאל)/i.test(cleaned))
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

  // "Grill-Me Pack" / "שאל אותי" must stay in this chat — never open Cursor mid-dialogue.
  if (isInteractiveConversationRequest(cleaned)) return null;
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

/**
 * Detect WhatsApp group job-scan intent (Hebrew or English).
 * Used by orchestration to invoke the scan_whatsapp_jobs MCP tool.
 */
export function detectWhatsappJobScan(text) {
  const cleaned = String(text || '').trim();
  if (!cleaned) return null;

  // Grill-Me / "ask me" dialogue stays with Claude — do not auto-scan mid-conversation.
  if (isInteractiveConversationRequest(cleaned)) return null;

  // Building/dispatching the scanner itself is a coding task, not a scan run.
  if (
    /(implement|refactor|dispatch_coding|skip\s+grill-?me|שגר\s*ל-?\s*cursor)/i.test(
      cleaned
    ) ||
    (/(add|create|build|הוסף|להוסיף|תיישם|לבנות)/i.test(cleaned) &&
      /(tool|כלי|mcp)/i.test(cleaned))
  ) {
    return null;
  }

  const mentionsWhatsapp = /whatsapp|וואטסאפ|ווטסאפ|וואצאפ/i.test(cleaned);
  const mentionsJobs =
    /משרות?|דרוש(?:ים|ות|ה)?|גיוס|jobs?|hiring|recruit/i.test(cleaned);
  const mentionsScan =
    /סרוק|לסרוק|תסרוק|סריק(?:ת|ה)?|scan|scrape|חפש(?:י|ו)?(?:\s+ב)?/i.test(cleaned);

  if (!mentionsWhatsapp) return null;
  if (!mentionsJobs) return null;
  // Prefer an explicit scan verb; also accept "whatsapp jobs in groups"
  if (!mentionsScan && !/(קבוצ|groups?)/i.test(cleaned)) return null;

  const roles = extractRoles(cleaned);
  const exportPath = extractExportPath(cleaned) || config.whatsappExportsDir;
  const groupNames = extractGroupNames(cleaned);

  return {
    mcpTool: 'scan_whatsapp_jobs',
    mcpArgs: {
      exportPath,
      ...(groupNames.length ? { groupNames } : {}),
      ...(roles.length ? { roles } : {}),
    },
  };
}

/**
 * Detect CV submit / apply intent for a WhatsApp-discovered job.
 * Drafts via submit_whatsapp_job_cv — never live-sends WhatsApp.
 */
export function detectWhatsappCvSubmit(text) {
  const cleaned = String(text || '').trim();
  if (!cleaned) return null;

  // e.g. "שאל אותי … Grill-Me Pack … והגשת קורות חיים" is a questionnaire request,
  // not an instruction to draft/submit a CV package right now.
  if (isInteractiveConversationRequest(cleaned)) return null;

  if (
    /(implement|refactor|dispatch_coding|skip\s+grill-?me|שגר\s*ל-?\s*cursor)/i.test(
      cleaned
    ) ||
    (/(add|create|build|הוסף|להוסיף|תיישם|לבנות)/i.test(cleaned) &&
      /(tool|כלי|mcp)/i.test(cleaned))
  ) {
    return null;
  }

  const mentionsCv =
    /קו["״]?ח|קורות\s*חיים|\bcv\b|\bresume\b|curriculum\s+vitae/i.test(cleaned);
  const mentionsSubmit =
    /הגש|להגיש|תגיש|שלח(?:י|ו)?|submit|apply|send\s+(my\s+)?(cv|resume)/i.test(
      cleaned
    );
  if (!mentionsCv || !mentionsSubmit) return null;

  const emailMatch = cleaned.match(
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i
  );
  const quoted = cleaned.match(/["«»„‟]([^"«»„‟]{20,2000})["«»„‟]/);
  const confirm =
    /\bconfirm\b|אשר(?:י|ו)?(?:\s+הגשה)?|ready\s+to\s+send|סמן\s+לשליחה/i.test(
      cleaned
    );

  return {
    mcpTool: 'submit_whatsapp_job_cv',
    mcpArgs: {
      ...(emailMatch ? { recipientEmail: emailMatch[0] } : {}),
      ...(quoted?.[1] ? { jobText: quoted[1].trim() } : {}),
      ...(confirm ? { confirm: true } : {}),
    },
    resolveFromScan: !emailMatch && !quoted?.[1],
  };
}

function extractRoles(text) {
  const roles = [];
  const patterns = [
    /(?:role|תפקיד|roles?)\s*[:=]\s*([^,.\n]+)/i,
    /\b(full\s*stack|backend|frontend|devops|product\s*manager|data\s*scientist|mobile|android|ios|qa)\b/i,
    /(פול\s*סטאק|בק.?אנד|פרונט|דבאופס|מנהל מוצר)/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m?.[1]) roles.push(m[1].trim());
  }
  return [...new Set(roles)].slice(0, 5);
}

function extractGroupNames(text) {
  const quoted = [...text.matchAll(/["«»„‟]([^"«»„‟]{2,80})["«»„‟]/g)].map((m) => m[1].trim());
  const labeled = text.match(/(?:group|קבוצ(?:ה|ות))\s*[:=]\s*([^,.\n]+)/i);
  const names = [...quoted];
  if (labeled?.[1]) names.push(labeled[1].trim());
  return [...new Set(names)].slice(0, 10);
}

function extractExportPath(text) {
  const labeled = text.match(
    /(?:export(?:Path)?|ייצוא|נתיב)\s*[:=]\s*["']?([A-Za-z]:[^"'\n]+|\/[^"'\n]+)/i
  );
  if (labeled?.[1] && fs.existsSync(labeled[1].trim())) {
    return path.resolve(labeled[1].trim());
  }
  return extractProjectPath(text);
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
