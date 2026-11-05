#!/usr/bin/env node
// BW launcher: fills the BW_* environment from .destination.properties and
// credentials.ini (both next to this file), then starts the bw-modeling-mcp stdio server.
// Variables already set in the environment win.
//
//   BW_MCP_DIR            bw-modeling-mcp checkout (default: modeling-mcp/bw, as built by npm run build)
//   BW_ECLIPSE_PROJECT    Eclipse project, used only when .destination.properties is missing
//                         here (default: S4H_100_flutran_en)
//   BW_ECLIPSE_WORKSPACE  Eclipse workspace folder (default: ~/eclipse-workspace)
//
// Defaults applied here: BW_STDIO_SCOPES=read (no write tools) and BW_CA_FILE=rootca.pem.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;

/** key=value lines, ignoring comments; [sections] are flattened as "section.key". */
function readProperties(file) {
  const props = {};
  let section = '';
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const header = line.match(/^\[(.+)\]$/);
    if (header) { section = header[1].trim(); continue; }
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    props[section ? `${section}.${key}` : key] = line.slice(eq + 1).trim();
  }
  return props;
}

function fail(message) {
  process.stderr.write(`[start-bw-mcp] ${message}\n`);
  process.exit(1);
}

const workspace = env.BW_ECLIPSE_WORKSPACE || path.join(os.homedir(), 'eclipse-workspace');
const project = env.BW_ECLIPSE_PROJECT || 'S4H_100_flutran_en';
const localDest = path.join(here, '.destination.properties');
const eclipseDest = path.join(workspace, '.metadata/.plugins/org.eclipse.core.resources.semantic/.cache',
  project, '.destination.properties');
const destFile = fs.existsSync(localDest) ? localDest : eclipseDest;
if (!fs.existsSync(destFile)) fail(`No .destination.properties next to this file nor in Eclipse project '${project}' (see README.md)`);
const dest = readProperties(destFile);

const credFile = path.join(here, 'credentials.ini');
const creds = fs.existsSync(credFile) ? readProperties(credFile) : {};

env.BW_URL ||= `https://${dest.server}:443${dest.systemNumber || '00'}`;
env.BW_CLIENT ||= dest.client || '100';
env.BW_LANGUAGE ||= dest.language || 'EN';
env.BW_USER ||= creds['sap.user'] || dest.user || '';
env.BW_PASSWORD ||= creds['sap.password'] || '';
env.BW_STDIO_SCOPES ??= 'read';
const ca = path.join(here, 'rootca.pem');
if (!env.BW_CA_FILE && fs.existsSync(ca)) env.BW_CA_FILE = ca;

if (!env.BW_USER || !env.BW_PASSWORD) fail(`BW user or password missing (set them in ${credFile})`);

const serverDir = env.BW_MCP_DIR || path.join(here, 'modeling-mcp', 'bw');
const entry = path.join(serverDir, 'dist/stdio.js');
if (!fs.existsSync(entry)) fail(`${entry} not found (run npm run build in ${here})`);
await import(pathToFileURL(entry).href);
