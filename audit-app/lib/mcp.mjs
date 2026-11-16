// One stdio connection to the bw-mcp server, shared by the audit collector and the chat.
// The server is started through the repository launcher (start-bw-mcp.mjs), always with
// BW_STDIO_SCOPES=read, so no write tool is ever offered.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const launcher = process.env.BW_LAUNCHER || path.join(repoRoot, 'start-bw-mcp.mjs');

// Tool names that could change the system. The read scope should not offer them;
// this list is a second fence for the chat.
const WRITE_PATTERN = /(^|_)(activate|create|update|delete|set|run|push|move|unlock|change|restart|start|swap|append|add|remove)(_|$)/;

let clientPromise = null;

async function connect() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [launcher],
    cwd: repoRoot,
    env: { ...process.env, BW_STDIO_SCOPES: 'read' },
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (chunk) => process.stderr.write(`[bw-mcp] ${chunk}`));
  const client = new Client({ name: 'bw-audit-app', version: '1.0.0' });
  await client.connect(transport);
  transport.onclose = () => { clientPromise = null; };
  return client;
}

export function getClient() {
  clientPromise ??= connect().catch((err) => { clientPromise = null; throw err; });
  return clientPromise;
}

/** Call a bw-mcp tool and return its text output. Throws on a tool error. */
export async function callTool(name, args = {}, { timeoutMs = 180_000 } = {}) {
  const client = await getClient();
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs });
  const text = (result.content || [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
  if (result.isError) {
    const err = new Error(text || `${name} failed`);
    err.toolError = true;
    throw err;
  }
  return text;
}

/** Read-only tools of the server, in the shape the Messages API expects. */
export async function listReadTools() {
  const client = await getClient();
  const { tools } = await client.listTools();
  return tools
    .filter((t) => !WRITE_PATTERN.test(t.name))
    .map((t) => ({
      name: t.name,
      description: (t.description || '').slice(0, 4000),
      input_schema: t.inputSchema || { type: 'object', properties: {} },
    }));
}

export async function closeClient() {
  if (!clientPromise) return;
  const client = await clientPromise.catch(() => null);
  clientPromise = null;
  await client?.close().catch(() => {});
}
