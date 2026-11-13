import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function fixture(t, { withDatasphere = true, customDirectory = false, snowflake = false, withSnowflake = true } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'migration-build-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'scripts'), { recursive: true });
  await copyFile(path.join(root, 'scripts/build.mjs'), path.join(dir, 'scripts/build.mjs'));
  // These shims keep the root-build test independent of BW remotes, installs and sign-in.
  const bin = path.join(dir, 'bin');
  await mkdir(bin);
  for (const name of ['git', 'npm', 'uv']) await writeFile(path.join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await mkdir(path.join(dir, 'modeling-mcp/bw/.git'), { recursive: true });
  await writeFile(path.join(dir, 'modeling-mcp/bw/package.json'), '{}');
  const datasphereDir = path.join(dir, customDirectory ? 'independent-datasphere' : 'modeling-mcp/datasphere');
  if (withDatasphere) {
    await mkdir(datasphereDir, { recursive: true });
    await copyFile(path.join(root, 'modeling-mcp/datasphere/build.mjs'), path.join(datasphereDir, 'build.mjs'));
  }
  const snowflakeDir = path.join(dir, customDirectory ? 'independent-snowflake' : 'modeling-mcp/snowflake-dbt');
  if (withSnowflake) {
    await mkdir(path.join(snowflakeDir, '.venv/bin'), { recursive: true });
    await copyFile(path.join(root, 'modeling-mcp/snowflake-dbt/build.mjs'), path.join(snowflakeDir, 'build.mjs'));
    await writeFile(path.join(snowflakeDir, '.venv/bin/python'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }
  const initial = { mcpServers: {
    'bw-mcp': { command: 'old-bw', env: { BW_STDIO_SCOPES: 'read', BW_CLIENT: '123' } },
    'datasphere-mcp': { command: 'old-datasphere', env: { DATASPHERE_SPACE: 'EXISTING', DATASPHERE_STDIO_SCOPES: 'read' } },
    custom: { command: 'custom-mcp', args: ['keep-me'] },
  } };
  const configPath = path.join(dir, '.mcp.json');
  if (snowflake) {
    delete initial.mcpServers['datasphere-mcp'];
    initial.mcpServers['snowflake-dbt-mcp'] = { command: 'old-snowflake', env: { SNOWFLAKE_DATABASE: 'EXISTING', SNOWFLAKE_DBT_SCOPES: 'read' } };
  }
  await writeFile(configPath, JSON.stringify(initial));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(BW_|FABRIC_|DATASPHERE_|SNOWFLAKE_|DBT_)/.test(key)));
  env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  if (customDirectory) env.DATASPHERE_MCP_DIR = datasphereDir;
  if (customDirectory) env.SNOWFLAKE_DBT_MCP_DIR = snowflakeDir;
  return { dir, env, initial, configPath, datasphereDir, snowflakeDir };
}

test('root build selects Datasphere, preserves settings and custom servers, and resolves its independent path', async (t) => {
  const context = await fixture(t);
  const { stdout } = await execute(process.execPath, ['scripts/build.mjs', '--yes'], { cwd: context.dir, env: context.env });
  assert.match(stdout, /Migration target\? SAP Datasphere/);
  const { mcpServers } = JSON.parse(await readFile(context.configPath, 'utf8'));
  assert.deepEqual(mcpServers.custom, context.initial.mcpServers.custom);
  assert.equal(mcpServers['bw-mcp'].env.BW_CLIENT, '123');
  assert.equal(mcpServers['datasphere-mcp'].env.DATASPHERE_SPACE, 'EXISTING');
  assert.equal(mcpServers['datasphere-mcp'].env.DATASPHERE_STDIO_SCOPES, 'read');
  assert.equal(mcpServers['datasphere-mcp'].command, process.execPath);
  assert.deepEqual(mcpServers['datasphere-mcp'].args, [path.join(context.datasphereDir, 'src/stdio.mjs')]);
});

test('explicit Datasphere environment overrides saved settings and supports a custom checkout', async (t) => {
  const context = await fixture(t, { customDirectory: true });
  context.env.DATASPHERE_HOST = 'https://example.invalid';
  context.env.DATASPHERE_SPACE = 'NEW';
  context.env.DATASPHERE_STDIO_SCOPES = 'read,write,execute';
  await execute(process.execPath, ['scripts/build.mjs', '--yes'], { cwd: context.dir, env: context.env });
  const { mcpServers } = JSON.parse(await readFile(context.configPath, 'utf8'));
  assert.equal(mcpServers['datasphere-mcp'].env.DATASPHERE_SPACE, 'NEW');
  assert.equal(mcpServers['datasphere-mcp'].env.DATASPHERE_HOST, 'https://example.invalid');
  assert.equal(mcpServers['datasphere-mcp'].env.DATASPHERE_STDIO_SCOPES, 'read,write,execute');
  assert.equal(mcpServers['datasphere-mcp'].args[0], path.join(context.datasphereDir, 'src/stdio.mjs'));
});

test('a missing independent Datasphere checkout fails without rewriting MCP configuration', async (t) => {
  const context = await fixture(t, { withDatasphere: false });
  await assert.rejects(execute(process.execPath, ['scripts/build.mjs', '--yes'], { cwd: context.dir, env: context.env }), (error) => {
    assert.match(error.stderr, /DATASPHERE_MCP_REPO/);
    return true;
  });
  assert.deepEqual(JSON.parse(await readFile(context.configPath, 'utf8')), context.initial);
});

test('root build selects saved Snowflake/dbt, supports custom paths and preserves non-secret settings', async (t) => {
  const context = await fixture(t, { snowflake: true, customDirectory: true });
  context.env.SNOWFLAKE_SCHEMA = 'NEW';
  context.env.DBT_ENV_SECRET_SNOWFLAKE_PASSWORD = 'must-not-persist';
  const { stdout } = await execute(process.execPath, ['scripts/build.mjs', '--yes'], { cwd: context.dir, env: context.env });
  assert.match(stdout, /Migration target\? Snowflake \+ dbt/);
  const text = await readFile(context.configPath, 'utf8');
  const { mcpServers } = JSON.parse(text);
  assert.deepEqual(mcpServers.custom, context.initial.mcpServers.custom);
  assert.equal(mcpServers['snowflake-dbt-mcp'].env.SNOWFLAKE_DATABASE, 'EXISTING');
  assert.equal(mcpServers['snowflake-dbt-mcp'].env.SNOWFLAKE_SCHEMA, 'NEW');
  assert.equal(mcpServers['snowflake-dbt-mcp'].env.SNOWFLAKE_DBT_SCOPES, 'read');
  assert.equal(mcpServers['snowflake-dbt-mcp'].command, path.join(context.snowflakeDir, '.venv/bin/python'));
  assert.ok(!text.includes('must-not-persist'));
});

test('explicit Snowflake/dbt selection switches targets and keeps custom servers', async (t) => {
  const context = await fixture(t);
  await execute(process.execPath, ['scripts/build.mjs', '--yes', '--target=snowflake-dbt'], { cwd: context.dir, env: context.env });
  const { mcpServers } = JSON.parse(await readFile(context.configPath, 'utf8'));
  assert.ok(mcpServers['snowflake-dbt-mcp']);
  assert.ok(!mcpServers['datasphere-mcp']);
  assert.deepEqual(mcpServers.custom, context.initial.mcpServers.custom);
});

test('missing Snowflake checkout and invalid target leave MCP configuration intact', async (t) => {
  const context = await fixture(t, { withSnowflake: false });
  for (const target of ['snowflake-dbt', 'unknown']) {
    await assert.rejects(execute(process.execPath, ['scripts/build.mjs', '--yes', `--target=${target}`], { cwd: context.dir, env: context.env }));
    assert.deepEqual(JSON.parse(await readFile(context.configPath, 'utf8')), context.initial);
  }
});
