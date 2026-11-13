#!/usr/bin/env node
// Sets up the MCP servers of this project and writes .mcp.json for them.
//
// Asks for the migration source and the migration target, prepares the MCP server of each
// and writes them into .mcp.json, the only MCP file Claude Code reads here:
//   source SAP BW            bw-mcp: fetches bw-modeling-mcp into modeling-mcp/bw and builds it
//   target Microsoft Fabric  fabric-mcp: fetches fabric-modeling-mcp into modeling-mcp/fabric and runs
//                            its build.mjs, which installs Microsoft's official Fabric MCP server and
//                            its sign-in
//   target SAP Datasphere    datasphere-mcp: runs the independent modeling-mcp/datasphere build
//   target Snowflake + dbt   snowflake-dbt-mcp: runs the independent modeling-mcp/snowflake-dbt build
//   target Databricks, Google BigQuery
//                            offered, but no MCP server yet: nothing is added for them
// Servers added to .mcp.json by hand are kept.
//
// The current .mcp.json gives the default answers. Without a terminal (CI, piped input) or
// with --yes, the defaults are used without asking.
//
//   BW_MCP_DIR         checkout folder        (default: modeling-mcp/bw, inside this project)
//   BW_MCP_REPO        git URL to clone from  (default: https://github.com/Franzz/bw-modeling-mcp.git)
//   BW_MCP_BRANCH      branch to check out    (default: bw-migration)
//   FABRIC_MCP_DIR     checkout folder        (default: modeling-mcp/fabric, inside this project)
//   FABRIC_MCP_REPO    git URL to clone from  (default: https://github.com/Franzz/fabric-modeling-mcp.git)
//   FABRIC_MCP_BRANCH  branch to check out    (default: main)
//   DATASPHERE_MCP_DIR checkout folder        (default: modeling-mcp/datasphere)
//   DATASPHERE_MCP_REPO optional git URL      (unset: use the existing independent local repo)
//   DATASPHERE_MCP_BRANCH branch to check out (default: main; used only with DATASPHERE_MCP_REPO)
//   SNOWFLAKE_DBT_MCP_DIR checkout folder     (default: modeling-mcp/snowflake-dbt)
//   SNOWFLAKE_DBT_MCP_REPO optional git URL   (unset: use the existing independent local repo)
//   SNOWFLAKE_DBT_MCP_BRANCH branch           (default: main; used only with SNOWFLAKE_DBT_MCP_REPO)
//
// For each checkout, first run: clones the branch. Later runs: fetches, switches to the branch and
// fast-forwards it. Local commits or uncommitted changes in a checkout are never discarded: git stops instead.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mcpFile = path.join(root, '.mcp.json');

/** The git checkout of an MCP server: folder, repository and branch, each overridable. */
function checkout(prefix, folder, repo, branch) {
  return {
    dir: path.resolve(process.env[`${prefix}_DIR`] || path.join(root, 'modeling-mcp', folder)),
    repo: process.env[`${prefix}_REPO`] || repo,
    branch: process.env[`${prefix}_BRANCH`] || branch,
  };
}
const bwCheckout = checkout('BW_MCP', 'bw', 'https://github.com/Franzz/bw-modeling-mcp.git', 'bw-migration');
const fabricCheckout = checkout('FABRIC_MCP', 'fabric', 'https://github.com/Franzz/fabric-modeling-mcp.git', 'main');
const datasphereCheckout = checkout('DATASPHERE_MCP', 'datasphere', undefined, 'main');
const snowflakeCheckout = checkout('SNOWFLAKE_DBT_MCP', 'snowflake-dbt', undefined, 'main');

function log(message) {
  process.stdout.write(`[build] ${message}\n`);
}

function run(cwd, cmd, args) {
  log(`${path.basename(cwd)}$ ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function readServers(file) {
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers || {};
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${err.message}`);
  }
}

/** Clones the branch into dir, or fetches, switches to it and fast-forwards it. */
function syncCheckout({ dir, repo, branch }) {
  if (!fs.existsSync(path.join(dir, '.git'))) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    run(path.dirname(dir), 'git', ['clone', '--branch', branch, repo, dir]);
  } else {
    // Use whichever remote points at the repo; fall back to origin.
    const remote = git(dir, 'remote').split('\n')
      .find((r) => git(dir, 'remote', 'get-url', r).replace(/\.git$/, '') === repo.replace(/\.git$/, '')) || 'origin';
    run(dir, 'git', ['fetch', remote, branch]);
    const hasLocal = git(dir, 'branch', '--list', branch) !== '';
    run(dir, 'git', hasLocal ? ['switch', branch] : ['switch', '-c', branch, '--track', `${remote}/${branch}`]);
    run(dir, 'git', ['merge', '--ff-only', `${remote}/${branch}`]);
  }
  // Deleted files do not stop git from switching or fast-forwarding, so a checkout whose
  // working tree was emptied gets this far: stop before npm runs in an empty folder.
  if (!fs.existsSync(path.join(dir, 'package.json'))) {
    const deleted = git(dir, 'ls-files', '--deleted').split('\n').filter(Boolean).length;
    throw new Error(`${dir} has no package.json` + (deleted
      ? ` (${deleted} tracked files deleted from the working tree). Restore them with`
        + ` "git -C ${dir} restore ." or delete the folder for a fresh clone.`
      : '. Delete the folder for a fresh clone.'));
  }
}

function buildBwServer() {
  const { dir, branch } = bwCheckout;
  syncCheckout(bwCheckout);
  run(dir, 'npm', [fs.existsSync(path.join(dir, 'package-lock.json')) ? 'ci' : 'install']);
  run(dir, 'npm', ['run', 'build']);
  log(`BW MCP server built: ${path.join(dir, 'dist/stdio.js')} (branch ${branch})`);
}

/** Fetches fabric-modeling-mcp, then runs its own build, which returns the .mcp.json entries. */
async function buildFabricServer({ interactive }) {
  const { dir, branch } = fabricCheckout;
  syncCheckout(fabricCheckout);
  const fabricBuild = path.join(dir, 'build.mjs');
  if (!fs.existsSync(fabricBuild)) throw new Error(`${fabricBuild} not found (branch ${branch})`);
  log(`Fabric MCP checkout ready: ${dir} (branch ${branch})`);
  return (await import(pathToFileURL(fabricBuild).href)).build({ interactive });
}

/** The Datasphere repo can be developed locally before a remote has been published. */
async function buildDatasphereServer(options) {
  const { dir, repo } = datasphereCheckout;
  if (repo) syncCheckout(datasphereCheckout);
  const entry = path.join(dir, 'build.mjs');
  if (!fs.existsSync(entry)) {
    throw new Error(`${entry} not found. Prepare the independent Datasphere repo there, or set DATASPHERE_MCP_REPO to clone it.`);
  }
  log(`Datasphere MCP checkout ready: ${dir}`);
  return (await import(pathToFileURL(entry).href)).build(options);
}

async function buildSnowflakeServer(options) {
  const { dir, repo } = snowflakeCheckout;
  if (repo) syncCheckout(snowflakeCheckout);
  const entry = path.join(dir, 'build.mjs');
  if (!fs.existsSync(entry)) {
    throw new Error(`${entry} not found. Prepare the independent Snowflake/dbt repo there, or set SNOWFLAKE_DBT_MCP_REPO to clone it.`);
  }
  log(`Snowflake/dbt MCP checkout ready: ${dir}`);
  return (await import(pathToFileURL(entry).href)).build(options);
}

// Systems a migration can read from (sources) and write to (targets).
// setup({ current, interactive }) prepares the system and returns its .mcp.json entries;
// names lists the entries it owns.
// A system without servers is offered but adds nothing to .mcp.json yet.
const SOURCES = [
  {
    label: 'SAP BW',
    names: ['bw-mcp'],
    setup: ({ current }) => {
      buildBwServer();
      return {
        'bw-mcp': {
          type: 'stdio',
          command: 'node',
          args: [path.join(root, 'start-bw-mcp.mjs')],
          // Keeps env set by hand; BW access is read-only unless changed there.
          env: { BW_STDIO_SCOPES: 'read', ...current['bw-mcp']?.env },
        },
      };
    },
  },
];

const TARGETS = [
  {
    label: 'Microsoft Fabric',
    names: ['fabric-mcp'],
    setup: buildFabricServer,
  },
  {
    label: 'SAP Datasphere',
    names: ['datasphere-mcp'],
    setup: buildDatasphereServer,
  },
  {
    label: 'Snowflake + dbt',
    names: ['snowflake-dbt-mcp'],
    setup: buildSnowflakeServer,
  },
  // Offered, but nothing to set up yet.
  ...['Databricks', 'Google BigQuery'].map((label) => ({ label, names: [] })),
];

/** Asks on a terminal; otherwise answers with the default. */
function createPrompter(interactive) {
  const rl = interactive ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null;
  return {
    /** Numbered list of the systems; returns the chosen one. */
    async pick(question, systems, fallback) {
      const options = systems.map((s) => s.label + (s.setup ? '' : ' (no MCP server yet)'));
      const fallbackIndex = systems.indexOf(fallback);
      if (!rl) {
        log(`${question} ${fallback.label} (default)`);
        return fallback;
      }
      process.stdout.write(`\n${question}\n${options.map((o, i) => `  ${i + 1}) ${o}`).join('\n')}\n`);
      for (;;) {
        const answer = (await rl.question(`Choice [${fallbackIndex + 1}]: `)).trim();
        if (!answer) return fallback;
        const system = systems[Number(answer) - 1];
        if (system) return system;
        process.stdout.write(`Type a number from 1 to ${options.length}.\n`);
      }
    },
    close() { rl?.close(); },
  };
}

const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY) && !process.argv.includes('--yes');
const prompt = createPrompter(interactive);
try {
  const current = readServers(mcpFile);
  // Default: the system already in .mcp.json, otherwise the first one.
  const defaultOf = (systems) => systems.find((s) => s.names.some((n) => n in current)) ?? systems[0];

  // Questions first, so the build runs unattended afterwards.
  const source = await prompt.pick('Migration source?', SOURCES, defaultOf(SOURCES));
  const targetFlag = process.argv.find((arg) => arg.startsWith('--target='))?.slice('--target='.length);
  const targetOverride = targetFlag === undefined ? undefined : TARGETS.find((s) =>
    ({ 'Microsoft Fabric': 'fabric', 'SAP Datasphere': 'datasphere', 'Snowflake + dbt': 'snowflake-dbt',
      Databricks: 'databricks', 'Google BigQuery': 'bigquery' })[s.label] === targetFlag);
  if (targetFlag !== undefined && !targetOverride) throw new Error(`Unknown --target=${targetFlag}. Use fabric, datasphere, snowflake-dbt, databricks or bigquery.`);
  const target = targetOverride ?? await prompt.pick('Migration target?', TARGETS, defaultOf(TARGETS));
  prompt.close();

  const chosen = [source, target].filter((system) => {
    if (!system.setup) log(`${system.label}: no MCP server yet, nothing added to .mcp.json`);
    return system.setup;
  });
  const added = {};
  for (const system of chosen) Object.assign(added, await system.setup({ current, interactive }));

  // Keep the servers added by hand, replace the ones this script manages.
  const servers = { ...current };
  for (const system of [...SOURCES, ...TARGETS]) for (const name of system.names) delete servers[name];
  Object.assign(servers, added);

  fs.writeFileSync(mcpFile, `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`);
  const names = Object.keys(servers);
  log(`${path.relative(root, mcpFile)} written: ${names.length ? names.join(', ') : 'no servers'}`);
  log('Restart Claude Code (in VS Code: Developer: Reload Window) to load the servers, then check them with /mcp.');
} catch (err) {
  prompt.close();
  process.stderr.write(`[build] failed: ${err.message}\n`);
  process.exit(1);
}
