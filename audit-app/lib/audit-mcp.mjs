#!/usr/bin/env node
// Stdio MCP server with one tool, audit_query, over data/latest.json.
// The headless Claude Code chat route loads it next to bw-mcp.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { AUDIT_TOOL, runAuditQuery } from './assistant.mjs';
import { readLatest, applyTarget } from './collect.mjs';

const server = new Server({ name: 'bw-audit', version: '1.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: AUDIT_TOOL.name, description: AUDIT_TOOL.description, inputSchema: AUDIT_TOOL.input_schema }],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== AUDIT_TOOL.name) {
    return { isError: true, content: [{ type: 'text', text: `Unknown tool ${req.params.name}` }] };
  }
  // Read the snapshot on every call, so a new audit run is picked up at once; score it
  // for the target selected in the page (AUDIT_TARGET, set by the chat route).
  const text = runAuditQuery(applyTarget(await readLatest(), process.env.AUDIT_TARGET), req.params.arguments || {});
  return { content: [{ type: 'text', text }] };
});

await server.connect(new StdioServerTransport());
