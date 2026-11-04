#!/usr/bin/env node
// Fetches the bw-modeling-mcp server into a folder next to this project and builds it.
//
//   BW_MCP_DIR     checkout folder        (default: ../bw-modeling-mcp, next to this project)
//   BW_MCP_REPO    git URL to clone from  (default: https://github.com/Franzz/bw-modeling-mcp.git)
//   BW_MCP_BRANCH  branch to check out    (default: bw-migration)
//
// First run: clones the branch. Later runs: fetches, switches to the branch and fast-forwards it.
// Local commits or uncommitted changes in the checkout are never discarded: git stops instead.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.resolve(process.env.BW_MCP_DIR || path.join(root, '..', 'bw-modeling-mcp'));
const repo = process.env.BW_MCP_REPO || 'https://github.com/Franzz/bw-modeling-mcp.git';
const branch = process.env.BW_MCP_BRANCH || 'bw-migration';

function run(cmd, args, cwd = dir) {
  process.stdout.write(`[build] ${path.basename(cwd)}$ ${cmd} ${args.join(' ')}\n`);
  execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
}

function git(...args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
}

try {
  if (!fs.existsSync(path.join(dir, '.git'))) {
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
  process.stdout.write(`[build] done: ${path.join(dir, 'dist/stdio.js')} (branch ${branch})\n`);
} catch (err) {
  process.stderr.write(`[build] failed: ${err.message}\n`);
  process.exit(1);
}
