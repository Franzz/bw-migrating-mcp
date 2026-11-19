#!/usr/bin/env node
// BW launcher: fills the BW_* environment from .destination.properties and
// credentials.ini (both next to this file, see scripts/bw-env.mjs), then starts the
// bw-modeling-mcp stdio server. Variables already set in the environment win.
//
//   BW_MCP_DIR            bw-modeling-mcp checkout (default: modeling-mcp/bw, as built by npm run build)
//   BW_ECLIPSE_PROJECT    Eclipse project, used only when .destination.properties is missing
//   BW_ECLIPSE_WORKSPACE  Eclipse workspace folder (default: ~/eclipse-workspace)
//
// Defaults applied here: BW_STDIO_SCOPES=read (no write tools) and BW_CA_FILE=rootca.pem.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadBwEnv } from './scripts/bw-env.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;

function fail(message) {
  process.stderr.write(`[start-bw-mcp] ${message}\n`);
  process.exit(1);
}

try {
  loadBwEnv(env, here);
} catch (err) {
  fail(err.message);
}
env.BW_STDIO_SCOPES ??= 'read';

const serverDir = env.BW_MCP_DIR || path.join(here, 'modeling-mcp', 'bw');
const entry = path.join(serverDir, 'dist/stdio.js');
if (!fs.existsSync(entry)) fail(`${entry} not found (run npm run build in ${here})`);
await import(pathToFileURL(entry).href);
