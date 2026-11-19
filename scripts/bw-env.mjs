// BW connection settings shared by start-bw-mcp.mjs and bw-api-patch/install.mjs.
//
// Fills the BW_* environment from .destination.properties and credentials.ini, both in the
// project root. Variables already set in the environment win.
//
//   BW_ECLIPSE_PROJECT    Eclipse project, used only when .destination.properties is missing
//   BW_ECLIPSE_WORKSPACE  Eclipse workspace folder (default: ~/eclipse-workspace)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** key=value lines, ignoring comments; [sections] are flattened as "section.key". */
export function readProperties(file) {
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

/**
 * Sets BW_URL, BW_CLIENT, BW_LANGUAGE, BW_USER, BW_PASSWORD and BW_CA_FILE in env where unset.
 * Throws when no destination is found or the user or password is missing.
 */
export function loadBwEnv(env = process.env, root = projectRoot) {
  const workspace = env.BW_ECLIPSE_WORKSPACE || path.join(os.homedir(), 'eclipse-workspace');
  const project = env.BW_ECLIPSE_PROJECT;
  const localDest = path.join(root, '.destination.properties');
  const eclipseDest = project && path.join(workspace, '.metadata/.plugins/org.eclipse.core.resources.semantic/.cache',
    project, '.destination.properties');
  const destFile = fs.existsSync(localDest) ? localDest : eclipseDest;
  if (!env.BW_URL && (!destFile || !fs.existsSync(destFile))) {
    throw new Error(project
      ? `No .destination.properties in ${root} nor in Eclipse project '${project}' (see README.md)`
      : `No .destination.properties in ${root}; copy it there or set BW_ECLIPSE_PROJECT (see README.md)`);
  }
  const dest = destFile && fs.existsSync(destFile) ? readProperties(destFile) : {};

  const credFile = path.join(root, 'credentials.ini');
  const creds = fs.existsSync(credFile) ? readProperties(credFile) : {};

  env.BW_URL ||= `https://${dest.server}:443${dest.systemNumber || '00'}`;
  env.BW_CLIENT ||= dest.client || '100';
  env.BW_LANGUAGE ||= dest.language || 'EN';
  env.BW_USER ||= creds['sap.user'] || dest.user || '';
  env.BW_PASSWORD ||= creds['sap.password'] || '';
  const ca = path.join(root, 'rootca.pem');
  if (!env.BW_CA_FILE && fs.existsSync(ca)) env.BW_CA_FILE = ca;

  if (!env.BW_USER || !env.BW_PASSWORD) throw new Error(`BW user or password missing (set them in ${credFile})`);
  return env;
}
