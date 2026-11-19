#!/usr/bin/env node
// Installs the ABAP patch of the BW API (bw-api-patch/abap) into the connected BW system.
//
// Only a classic SAP BW release (SAP BW 7.x, standalone or embedded in S/4HANA) needs it; on BW/4HANA nothing is done.
// Each part is checked first and only what is missing or outdated is installed:
//
//   Accept header enhancement   post-exit on CL_RSO_RES_RESOURCE. Checked over HTTP; it cannot
//                               be created over ADT, so a missing one is reported with the
//                               SE24 steps (README.md) and never installed automatically.
//   ZCL_BWMCP_DTP_FILTER        class, created or updated over ADT and activated
//   ZCL_BWMCP_HTTP              class, created or updated over ADT and activated
//   ICF service /sap/bc/zbwmcp  created and activated by the temporary class ZCL_BWMCP_INSTALL,
//                               run through the ADT classrun service, then deleted again
//
//   node bw-api-patch/install.mjs           check, show the plan, ask before changing anything
//   node bw-api-patch/install.mjs --check   check only, change nothing
//   node bw-api-patch/install.mjs --yes     check and apply without asking
//
//   BW_PATCH_PACKAGE    package of the created objects (default $TMP: local, not transportable)
//   BW_PATCH_TRANSPORT  transport request, required for a package other than a local $ one
//   BW_HELPER_PATH      ICF path of the helper (default /sap/bc/zbwmcp), as read by bw-mcp
//
// The connection comes from .destination.properties and credentials.ini (scripts/bw-env.mjs)
// and the BW client of the built bw-mcp server (modeling-mcp/bw/dist).
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

export const HELPER_CLASSES = [
  { name: 'ZCL_BWMCP_DTP_FILTER', file: 'abap/zcl_bwmcp_dtp_filter.abap', description: 'BW MCP: DTP filter reader' },
  { name: 'ZCL_BWMCP_HTTP', file: 'abap/zcl_bwmcp_http.abap', description: 'BW MCP: helper HTTP handler' },
];
export const ICF_INSTALLER = { name: 'ZCL_BWMCP_INSTALL', file: 'abap/zcl_bwmcp_install.abap', description: 'BW MCP: ICF service setup' };

const CLASS_MEDIA_TYPE = 'application/vnd.sap.adt.oo.classes.v4+xml';

/** Line endings and trailing blanks differ between the file and what ADT returns. */
export function normalizeSource(source) {
  return source.replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/\s+$/, '')).join('\n').trim();
}

export function readSource(file) {
  return fs.readFileSync(path.join(here, file), 'utf8');
}

/** The version the bundled HTTP handler reports, from its c_version constant. */
export function bundledHelperVersion() {
  return readSource('abap/zcl_bwmcp_http.abap').match(/c_version\s+TYPE\s+string\s+VALUE\s+'([^']+)'/i)?.[1] ?? null;
}

const xmlAttr = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const isHttp = (err, code) => new RegExp(`HTTP ${code}\\b`).test(String(err?.message ?? err));

export function patchSettings(env = process.env) {
  const pkg = (env.BW_PATCH_PACKAGE || '$TMP').trim().toUpperCase();
  const transport = (env.BW_PATCH_TRANSPORT || '').trim().toUpperCase();
  if (!pkg.startsWith('$') && !transport) {
    throw new Error(`BW_PATCH_PACKAGE=${pkg} is transportable: set BW_PATCH_TRANSPORT to the request to record the objects on`);
  }
  const helperPath = (env.BW_HELPER_PATH || '/sap/bc/zbwmcp').trim();
  return { pkg, transport, helperPath };
}

// ── Checks (read-only) ──────────────────────────────────────────────────────

/** Active source of a class, or null when the class has no active version. */
export async function activeClassSource(client, name) {
  try {
    const { body } = await client.rawGet(`/sap/bc/adt/oo/classes/${name.toLowerCase()}/source/main?version=active`, { Accept: 'text/plain' });
    return body;
  } catch (err) {
    if (isHttp(err, 404)) return null;
    throw err;
  }
}

/**
 * Is the Accept header enhancement in place? Same probe as bw_system_profile: an aDSO that
 * cannot exist, requested in the media type the system publishes. 404 or 415 mean the header
 * was read; 406 means negotiation fell back to version 1.0.0, the defect the exit fixes.
 */
export async function probeAcceptHeader(client, accept) {
  if (!accept || /v1_0_0/.test(accept)) {
    return { state: 'unknown', detail: 'the system publishes no aDSO media type above 1.0.0 to probe with' };
  }
  try {
    await client.rawGet('/sap/bw/modeling/adso/zz_probe_does_not_exist/m', { Accept: accept });
    return { state: 'ok', detail: 'negotiation succeeded' };
  } catch (err) {
    if (isHttp(err, 404) || isHttp(err, 415)) return { state: 'ok', detail: 'the Accept header is read' };
    if (isHttp(err, 406)) return { state: 'manual', detail: 'HTTP 406: the Accept header is not read — create the post-exit in SE24 (bw-api-patch/README.md, step 1)' };
    return { state: 'unknown', detail: String(err.message).split('\n')[0] };
  }
}

/** What the helper endpoint answers: its version, or why it does not. */
export async function probeHelper(client, helperPath) {
  try {
    const { body } = await client.rawGet(helperPath, { Accept: 'application/json' });
    const json = JSON.parse(body);
    return json.service === 'bwmcp' ? { found: true, version: json.version ?? null } : { found: false, detail: 'another service answers there' };
  } catch (err) {
    if (isHttp(err, 404)) return { found: false, detail: 'not found (HTTP 404)' };
    if (isHttp(err, 403)) return { found: false, detail: 'inactive or not authorised (HTTP 403)' };
    return { found: false, detail: String(err.message).split('\n')[0] };
  }
}

/**
 * The plan: one step per part with its state (ok, missing, outdated, manual, unknown).
 * Reads only. `accept` is the aDSO media type the system publishes.
 */
export async function inspect(client, { accept, helperPath, pkg }) {
  const steps = [];
  const header = await probeAcceptHeader(client, accept);
  steps.push({ id: 'header', label: 'Accept header enhancement (post-exit on CL_RSO_RES_RESOURCE)', ...header });

  for (const cls of HELPER_CLASSES) {
    const installed = await activeClassSource(client, cls.name);
    const wanted = readSource(cls.file);
    if (installed === null) steps.push({ id: 'class', cls, label: cls.name, state: 'missing', detail: `create in ${pkg} and activate` });
    else if (normalizeSource(installed) !== normalizeSource(wanted)) steps.push({ id: 'class', cls, label: cls.name, state: 'outdated', detail: 'update to the bundled source and activate' });
    else steps.push({ id: 'class', cls, label: cls.name, state: 'ok', detail: 'active source matches the bundle' });
  }

  const helper = await probeHelper(client, helperPath);
  const wantedVersion = bundledHelperVersion();
  if (!helper.found) {
    steps.push({ id: 'icf', label: `ICF service ${helperPath}`, state: 'missing', detail: `${helper.detail}; create and activate it` });
  } else {
    const classesChange = steps.some((s) => s.id === 'class' && s.state !== 'ok');
    steps.push({
      id: 'icf', label: `ICF service ${helperPath}`, state: 'ok',
      detail: `answers version ${helper.version}${helper.version !== wantedVersion && !classesChange ? ` (bundle has ${wantedVersion})` : ''}`,
    });
  }
  return steps;
}

// ── Changes (ADT writes) ────────────────────────────────────────────────────

async function createClass(client, cls, { pkg, transport }, source) {
  const lower = cls.name.toLowerCase();
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<class:abapClass xmlns:class="http://www.sap.com/adt/oo/classes" xmlns:adtcore="http://www.sap.com/adt/core"
 adtcore:type="CLAS/OC" adtcore:name="${xmlAttr(cls.name)}" adtcore:description="${xmlAttr(cls.description)}"
 adtcore:language="EN" adtcore:masterLanguage="EN" adtcore:responsible="${xmlAttr(String(process.env.BW_USER || '').toUpperCase())}">
 <adtcore:packageRef adtcore:name="${xmlAttr(pkg)}"/>
</class:abapClass>`;
  await client.rawPost(`/sap/bc/adt/oo/classes${transport ? `?corrNr=${encodeURIComponent(transport)}` : ''}`, body, {
    'Content-Type': CLASS_MEDIA_TYPE,
    Accept: CLASS_MEDIA_TYPE,
    'X-CSRF-Token': await client.getCsrfToken(),
    'X-sap-adt-sessiontype': 'stateful',
  });
  await writeSource(client, lower, source, transport);
}

async function writeSource(client, lower, source, transport) {
  const handle = await client.adtLockClass(lower);
  try {
    if (transport) {
      await client.rawPut(
        `/sap/bc/adt/oo/classes/${lower}/source/main?lockHandle=${encodeURIComponent(handle)}&corrNr=${encodeURIComponent(transport)}`,
        source,
        { 'Content-Type': 'text/plain; charset=utf-8', Accept: 'text/plain', 'X-CSRF-Token': await client.getCsrfToken() },
      );
    } else {
      await client.adtPutSource(lower, handle, source);
    }
  } finally {
    await client.adtUnlockClass(lower, handle);
  }
}

async function activateVerified(client, cls, source) {
  await client.adtActivate(cls.name.toLowerCase(), cls.name);
  const active = await activeClassSource(client, cls.name);
  if (active === null || normalizeSource(active) !== normalizeSource(source)) {
    throw new Error(`${cls.name}: activation did not take — check the class in SE24 or Eclipse for syntax errors`);
  }
}

async function deleteClass(client, cls, transport) {
  const lower = cls.name.toLowerCase();
  const handle = await client.adtLockClass(lower);
  await client.rawDelete(`/sap/bc/adt/oo/classes/${lower}?lockHandle=${encodeURIComponent(handle)}${transport ? `&corrNr=${encodeURIComponent(transport)}` : ''}`, {});
}

/** Creates and activates the ICF node through the temporary installer class. */
async function installIcfService(client, settings, log) {
  const cls = ICF_INSTALLER;
  const source = readSource(cls.file).replace(/c_package TYPE devclass VALUE '[^']*'/, `c_package TYPE devclass VALUE '${settings.pkg}'`);
  if ((await activeClassSource(client, cls.name)) === null) await createClass(client, cls, settings, source);
  else await writeSource(client, cls.name.toLowerCase(), source, settings.transport);
  await activateVerified(client, cls, source);
  let output;
  try {
    // A new session: the one that just edited and activated the class still holds the old
    // program load, and classrun there answers "Class does not implement
    // if_oo_adt_classrun~main method!" (verified on SAP_BW 758).
    const runClient = typeof client.freshSession === 'function' ? client.freshSession() : client;
    ({ body: output } = await runClient.rawPost(`/sap/bc/adt/oo/classrun/${cls.name}`, '', {
      Accept: 'text/plain',
      'X-CSRF-Token': await runClient.getCsrfToken(),
    }));
  } finally {
    try {
      await deleteClass(client, cls, settings.transport);
    } catch (err) {
      log(`warning: ${cls.name} could not be deleted (${String(err.message).split('\n')[0]}); delete it in SE24, it is no longer needed`);
    }
  }
  for (const line of output.trim().split('\n')) log(`  ${line}`);
  if (!/SUCCESS/.test(output)) throw new Error(`ICF service setup failed: ${output.trim().split('\n').pop()}`);
}

export async function applySteps(client, steps, settings, log) {
  for (const step of steps.filter((s) => s.id === 'class' && s.state !== 'ok')) {
    const source = readSource(step.cls.file);
    log(`${step.state === 'missing' ? 'Creating' : 'Updating'} ${step.cls.name}`);
    if (step.state === 'missing') await createClass(client, step.cls, settings, source);
    else await writeSource(client, step.cls.name.toLowerCase(), source, settings.transport);
    await activateVerified(client, step.cls, source);
    log(`${step.cls.name} active`);
  }
  if (steps.some((s) => s.id === 'icf' && s.state === 'missing')) {
    log(`Creating the ICF service ${settings.helperPath}`);
    await installIcfService(client, settings, log);
  }
}

// ── Entry points ────────────────────────────────────────────────────────────

const MARK = { ok: 'ok', missing: 'missing', outdated: 'outdated', manual: 'manual', unknown: '?' };

function report(steps, log) {
  for (const s of steps) log(`  [${MARK[s.state].padEnd(8)}] ${s.label} — ${s.detail}`);
}

/**
 * Checks the patch and, when `apply` allows it, installs what is missing.
 *   apply: true   install without asking
 *   apply: false  check only
 *   apply: 'ask'  show the plan and ask on the terminal (needs interactive)
 * Returns { status: 'bw4' | 'complete' | 'pending' | 'applied' | 'manual', steps }.
 */
export async function install({ apply = 'ask', interactive = false, log = (m) => process.stdout.write(`${m}\n`), env = process.env } = {}) {
  const { loadBwEnv } = await import(pathToFileURL(path.join(root, 'scripts/bw-env.mjs')).href);
  loadBwEnv(env, root);
  const settings = patchSettings(env);
  const serverDir = env.BW_MCP_DIR || path.join(root, 'modeling-mcp', 'bw');
  const dist = (f) => pathToFileURL(path.join(serverDir, 'dist', f)).href;
  if (!fs.existsSync(path.join(serverDir, 'dist/bw-client.js'))) throw new Error(`${serverDir}/dist not built (run npm run build first)`);
  const { createClientFromEnv, MEDIA_TYPES } = await import(dist('bw-client.js'));
  const { ensurePlatform } = await import(dist('platform.js'));
  const client = createClientFromEnv();

  const profile = await ensurePlatform(client);
  if (!profile.detected) throw new Error(`cannot reach ${env.BW_URL}: ${profile.detail}`);
  if (profile.platform !== 'classic') {
    log(`${env.BW_URL} is BW/4HANA: no patch needed`);
    return { status: 'bw4', steps: [] };
  }
  await client.loadMediaTypes().catch(() => {});

  log(`BW API patch on ${env.BW_URL} (client ${env.BW_CLIENT}, user ${env.BW_USER}), classic SAP BW:`);
  const options = { accept: MEDIA_TYPES.adso, helperPath: settings.helperPath, pkg: settings.pkg };
  let steps = await inspect(client, options);
  report(steps, log);

  const todo = steps.filter((s) => s.state === 'missing' || s.state === 'outdated');
  const manual = steps.filter((s) => s.state === 'manual');
  const done = (status) => {
    if (manual.length) log('The header enhancement is a manual step in SE24: see bw-api-patch/README.md, step 1.');
    return { status, steps };
  };
  if (todo.length === 0) {
    log(manual.length ? 'Nothing to install automatically.' : 'Nothing to install: the patch is complete.');
    return done(manual.length ? 'manual' : 'complete');
  }

  let go = apply === true;
  if (apply === 'ask' && interactive) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const target = settings.pkg.startsWith('$') ? `package ${settings.pkg}` : `package ${settings.pkg}, request ${settings.transport}`;
    const answer = (await rl.question(`Install ${todo.length} part(s) into ${env.BW_URL} (${target})? [y/N] `)).trim();
    rl.close();
    go = /^y(es)?$/i.test(answer);
  }
  if (!go) {
    log('Not installed. Run "npm run bw-api-patch" to install the missing parts.');
    return done('pending');
  }

  await applySteps(client, steps, settings, log);
  steps = await inspect(client, options);
  log('After installation:');
  report(steps, log);
  const left = steps.filter((s) => s.state === 'missing' || s.state === 'outdated');
  if (left.length) throw new Error(`still not installed: ${left.map((s) => s.label).join(', ')}`);
  if (!settings.pkg.startsWith('$')) {
    log(`Objects recorded on ${settings.transport}. Add R3TR SICF for the ICF service to it by hand (SICF creates it without a request here).`);
  }
  return done('applied');
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const args = process.argv.slice(2);
  const apply = args.includes('--check') ? false : args.includes('--yes') ? true : 'ask';
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  install({ apply, interactive }).catch((err) => {
    process.stderr.write(`[bw-api-patch] failed: ${err.message}\n`);
    process.exit(1);
  });
}
