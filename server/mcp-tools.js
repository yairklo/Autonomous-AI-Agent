import path from 'node:path';
import { config } from './config.js';
import { resolveDispatchScript, runDispatchTask } from './task-router.js';
import { scanWhatsappJobs } from './whatsapp-job-scanner.js';

/**
 * Local MCP tool registry for the voice-agent orchestration layer.
 * Coding work is exposed only via dispatch_coding_task — Claude must not
 * edit files or run raw shell commands itself.
 * WhatsApp job scanning is exposed via scan_whatsapp_jobs (local chat exports).
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
      'Scans local WhatsApp group chat export .txt files for job postings (Hebrew/English). Does not connect to live WhatsApp; use Export chat files.',
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
          description: 'Optional group name filters (substring match).',
        },
        keywords: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional extra/override job keywords.',
        },
        roles: {
          type: 'array',
          items: { type: 'string' },
          description: 'Desired roles to boost relevance (e.g. Full Stack, DevOps).',
        },
        since: {
          type: 'string',
          description: 'ISO date/time; ignore older messages.',
        },
        limit: {
          type: 'number',
          description: 'Max job matches to return (default 50).',
        },
      },
      required: [],
    },
  },
];

export function getMcpTool(name) {
  return MCP_TOOLS.find((t) => t.name === name) || null;
}

export function listMcpTools() {
  return MCP_TOOLS.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  }));
}

/**
 * Execute a registered MCP tool by name.
 * @returns {{ ok: boolean, tool: string, result?: object, error?: string }}
 */
export async function executeMcpTool(name, args = {}, { onLog, signal } = {}) {
  const tool = getMcpTool(name);
  if (!tool) {
    const err = new Error(`Unknown MCP tool: ${name}`);
    err.code = 'MCP_UNKNOWN_TOOL';
    throw err;
  }

  if (name === 'dispatch_coding_task') {
    return executeDispatchCodingTask(args, { onLog, signal });
  }
  if (name === 'scan_whatsapp_jobs') {
    return executeScanWhatsappJobs(args, { onLog });
  }

  const err = new Error(`MCP tool not implemented: ${name}`);
  err.code = 'MCP_NOT_IMPLEMENTED';
  throw err;
}

async function executeDispatchCodingTask(args, { onLog, signal } = {}) {
  const projectPath = String(args.projectPath || '').trim() || config.root;
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

  const result = await runDispatchTask(
    { project: projectPath, task: taskDescription },
    { onLog, signal }
  );

  onLog?.(`[mcp] tool=dispatch_coding_task status=ok exit=${result.code ?? 0}`);

  return {
    ok: true,
    tool: 'dispatch_coding_task',
    projectPath,
    taskDescription,
    result,
  };
}

function executeScanWhatsappJobs(args = {}, { onLog } = {}) {
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

  // If default dir is empty, fall back to bundled fixture so demos/tests work.
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
