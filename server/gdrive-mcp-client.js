import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OAuth2Client } from 'google-auth-library';

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
  const customTools = [
    {
      name: 'gdrive_create_file',
      description: 'Creates a new text file in Google Drive.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Name of the file to create' },
          content: { type: 'string', description: 'Text, CSV, or HTML content to write into the file' },
          targetMimeType: { type: 'string', description: 'Optional. Google Workspace format to convert to (e.g., application/vnd.google-apps.document, application/vnd.google-apps.spreadsheet, application/vnd.google-apps.presentation). Omit to keep as plain text.' }
        },
        required: ['name', 'content']
      },
      isExternal: true
    }
  ];
  return [...gdriveTools.map(t => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    isExternal: true
  })), ...customTools];
}

export async function executeGdriveTool(name, args, { onLog }) {
  if (name === 'gdrive_create_file') {
    onLog?.(`[mcp-gdrive] custom tool=${name} args=${JSON.stringify(args)}`);
    const credPath = path.join(dataDir, 'gdrive-credentials.json');
    const tokenPath = path.join(dataDir, 'gdrive-tokens.json');
    const creds = JSON.parse(fs.readFileSync(credPath, 'utf8'));
    const tokens = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
    const client = new OAuth2Client(creds.installed?.client_id || creds.web?.client_id, creds.installed?.client_secret || creds.web?.client_secret);
    client.setCredentials(tokens);
    const metadata = { name: args.name };
    if (args.targetMimeType) {
      metadata.mimeType = args.targetMimeType;
    }
    const boundary = 'foo_bar_baz';
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: text/plain\r\n\r\n${args.content}\r\n--${boundary}--`;
    
    try {
      const res = await client.request({
        url: 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
        method: 'POST',
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        data: body
      });
      return {
        content: [{ type: 'text', text: `Successfully created file: ${JSON.stringify(res.data)}` }],
        isError: false
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Failed to create file: ${err.message}` }],
        isError: true
      };
    }
  }

  if (!mcpClient) {
    throw new Error("GDrive MCP client is not initialized. Run initGdriveMcp() first.");
  }
  
  onLog?.(`[mcp-gdrive] tool=${name} args=${JSON.stringify(args)}`);
  try {
    const result = await mcpClient.callTool({
      name,
      arguments: args
    });
    return result;
  } catch (err) {
    onLog?.(`[mcp-gdrive] error calling tool ${name}: ${err.message}`);
    throw err;
  }
}
