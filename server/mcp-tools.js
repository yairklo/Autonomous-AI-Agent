import { config } from './config.js';
import { resolveDispatchScript, runDispatchTask } from './task-router.js';

/**
 * Local MCP tool registry for the voice-agent orchestration layer.
 * Coding work is exposed only via dispatch_coding_task — Claude must not
 * edit files or run raw shell commands itself.
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
