#!/usr/bin/env node
// Sets up the MCP servers of this project and writes .mcp.json for them.
//
// Asks for the migration source and the migration target, prepares the MCP server of each
// and writes them into .mcp.json, the only MCP file Claude Code reads here:
//   source SAP BW            bw-mcp: fetches bw-modeling-mcp into modeling-mcp/bw and builds it
//   target Microsoft Fabric  fabric-mcp: runs the Fabric build modeling-mcp/fabric/build.mjs, which
//                            installs Microsoft's official Fabric MCP server and its sign-in
//   target Snowflake, Databricks, Google BigQuery
//                            offered, but no MCP server yet: nothing is added for them
// Servers added to .mcp.json by hand are kept.
//
// The current .mcp.json gives the default answers. Without a terminal (CI, piped input) or
// with --yes, the defaults are used without asking.
//
//   BW_MCP_DIR     checkout folder        (default: modeling-mcp/bw, inside this project)
//   BW_MCP_REPO    git URL to clone from  (default: https://github.com/Franzz/bw-modeling-mcp.git)
//   BW_MCP_BRANCH  branch to check out    (default: bw-migration)
//
// First run: clones the branch. Later runs: fetches, switches to the branch and fast-forwards it.
// Local commits or uncommitted changes in the checkout are never discarded: git stops instead.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.resolve(process.env.BW_MCP_DIR || path.join(root, 'modeling-mcp', 'bw'));
const repo = process.env.BW_MCP_REPO || 'https://github.com/Franzz/bw-modeling-mcp.git';
const branch = process.env.BW_MCP_BRANCH || 'bw-migration';
const mcpFile = path.join(root, '.mcp.json');

function log(message) {
  process.stdout.write(`[build] ${message}\n`);
}

function run(cmd, args, cwd = dir) {
  log(`${path.basename(cwd)}$ ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
}

function git(...args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
}

function readServers(file) {
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers || {};
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${err.message}`);
  }
}

function buildBwServer() {
  if (!fs.existsSync(path.join(dir, '.git'))) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    run('git', ['clone', '--branch', branch, repo, dir], path.dirname(dir));
  } else {
    // Use whichever remote points at the repo; fall back to origin.
    const remote = git('remote').split('\n')
      .find((r) => git('remote', 'get-url', r).replace(/\.git$/, '') === repo.replace(/\.git$/, '')) || 'origin';
    run('git', ['fetch', remote, branch]);
    const hasLocal = git('branch', '--list', branch) !== '';
    run('git', hasLocal ? ['switch', branch] : ['switch', '-c', branch, '--track', `${remote}/${branch}`]);
    run('git', ['merge', '--ff-only', `${remote}/${branch}`]);
  }
  // Deleted files do not stop git from switching or fast-forwarding, so a checkout whose
  // working tree was emptied gets this far: stop before npm runs in an empty folder.
  if (!fs.existsSync(path.join(dir, 'package.json'))) {
    const deleted = git('ls-files', '--deleted').split('\n').filter(Boolean).length;
    throw new Error(`${dir} has no package.json` + (deleted
      ? ` (${deleted} tracked files deleted from the working tree). Restore them with`
        + ` "git -C ${dir} restore ." or delete the folder for a fresh clone.`
      : '. Delete the folder for a fresh clone.'));
  }
  run('npm', [fs.existsSync(path.join(dir, 'package-lock.json')) ? 'ci' : 'install']);
  run('npm', ['run', 'build']);
  log(`BW MCP server built: ${path.join(dir, 'dist/stdio.js')} (branch ${branch})`);
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

const fabricBuild = path.join(root, 'modeling-mcp', 'fabric', 'build.mjs');
const TARGETS = [
  {
    label: 'Microsoft Fabric',
    names: ['fabric-mcp'],
    missing: fs.existsSync(fabricBuild) ? null : `${path.relative(root, fabricBuild)} not found`,
    setup: async ({ interactive }) => (await import(pathToFileURL(fabricBuild).href)).build({ interactive }),
  },
  // Offered, but nothing to set up yet.
  ...['Snowflake', 'Databricks', 'Google BigQuery'].map((label) => ({ label, names: [] })),
];

/** Asks on a terminal; otherwise answers with the default. */
function createPrompter(interactive) {
  const rl = interactive ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null;
  return {
    /** Numbered list of the systems; returns the chosen one. */
    async pick(question, systems, fallback) {
      const options = systems.map((s) => s.label
        + (s.missing ? ` (unavailable: ${s.missing})` : s.setup ? '' : ' (no MCP server yet)'));
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
        if (system && !system.missing) return system;
        process.stdout.write(system ? `${system.label} is unavailable: ${system.missing}\n` : `Type a number from 1 to ${options.length}.\n`);
      }
    },
    close() { rl?.close(); },
  };
}

const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY) && !process.argv.includes('--yes');
const prompt = createPrompter(interactive);
try {
  const current = readServers(mcpFile);
  // Default: the system already in .mcp.json, otherwise the first available one.
  const defaultOf = (systems) => systems.find((s) => !s.missing && s.names.some((n) => n in current))
    ?? systems.find((s) => !s.missing);
  if (!defaultOf(TARGETS)) throw new Error(`No migration target available (${TARGETS[0].missing})`);

  // Questions first, so the build runs unattended afterwards.
  const source = await prompt.pick('Migration source?', SOURCES, defaultOf(SOURCES));
  const target = await prompt.pick('Migration target?', TARGETS, defaultOf(TARGETS));
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
