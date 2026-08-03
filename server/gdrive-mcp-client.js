import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const dataDir = path.join(root, 'data');

let mcpClient = null;
let gdriveTools = [];
let initPromise = null;

export async function initGdriveMcp(onLog) {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      // Helper: If environment variables for JSON credentials/tokens exist, write them to disk.
      // This provides a fallback for external SDKs that strictly require physical files.
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      
      if (process.env.GDRIVE_CREDENTIALS_JSON) {
        const credPath = path.join(dataDir, 'gdrive-credentials.json');
        fs.writeFileSync(credPath, process.env.GDRIVE_CREDENTIALS_JSON, 'utf8');
        onLog?.("[mcp-gdrive] Wrote GDRIVE_CREDENTIALS_JSON to data/gdrive-credentials.json");
      }
      
      if (process.env.GDRIVE_TOKENS_JSON) {
        const tokenPath = path.join(dataDir, 'gdrive-tokens.json');
        fs.writeFileSync(tokenPath, process.env.GDRIVE_TOKENS_JSON, 'utf8');
        onLog?.("[mcp-gdrive] Wrote GDRIVE_TOKENS_JSON to data/gdrive-tokens.json");
      }

      const credPath = path.join(dataDir, 'gdrive-credentials.json');
      const tokenPath = path.join(dataDir, 'gdrive-tokens.json');

      const transport = new StdioClientTransport({
        command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
        args: ["-y", "dylancaponi/gdrive-mcp-server"],
        env: {
          ...process.env,
          GDRIVE_OAUTH_PATH: credPath,
          GDRIVE_CREDENTIALS_PATH: tokenPath,
        }
      });

      mcpClient = new Client(
        {
          name: "voice-agent-gdrive-client",
          version: "1.0.0",
        },
        {
          capabilities: {},
        }
      );

      await mcpClient.connect(transport);
      onLog?.("[mcp-gdrive] connected to dylancaponi/gdrive-mcp-server");

      const toolsRes = await mcpClient.listTools();
      gdriveTools = toolsRes.tools || [];
      onLog?.(`[mcp-gdrive] loaded ${gdriveTools.length} tools`);
      
      return true;
    } catch (err) {
      onLog?.(`[mcp-gdrive] error connecting: ${err.message}`);
      initPromise = null; // allow retry
      throw err;
    }
  })();
  return initPromise;
}

export function getGdriveTools() {
  return gdriveTools.map(t => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    isExternal: true
  }));
}

export async function executeGdriveTool(name, args, { onLog }) {
  if (!mcpClient) {
    throw new Error("GDrive MCP client is not initialized. Run initGdriveMcp() first.");
  }
  
  onLog?.(`[mcp-gdrive] tool=${name} args=${JSON.stringify(args)}`);
  try {
    const result = await mcpClient.callTool({
      name,
      arguments: args
    });
    // MCP tool responses are typically { content: [{ type: 'text', text: '...' }], isError: boolean }
    return result;
  } catch (err) {
    onLog?.(`[mcp-gdrive] error calling tool ${name}: ${err.message}`);
    throw err;
  }
}
