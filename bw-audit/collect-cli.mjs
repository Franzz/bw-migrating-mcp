#!/usr/bin/env node
// npm run audit: runs the audit against BW and writes data/latest.json.
import { runAudit, LATEST } from './lib/collect.mjs';
import { closeClient } from './lib/mcp.mjs';
import { TARGETS } from './lib/targets.mjs';

// npm run audit -- --target=fabric|snowflake-dbt|datasphere|bigquery (default generic)
const arg = process.argv.slice(2).find((a) => a.startsWith('--target='));
const target = arg?.slice('--target='.length);
if (target && !TARGETS[target]) {
  console.error(`Unknown target "${target}". Use one of: ${Object.keys(TARGETS).join(', ')}`);
  process.exit(1);
}

try {
  const audit = await runAudit({
    target,
    onProgress: ({ pct, detail }) => process.stderr.write(`[${String(pct).padStart(3)}%] ${detail}\n`),
  });
  const s = audit.summary.custom;
  console.log(`\nTarget: ${audit.target.label}. Complexity index ${s.index}/100 (${s.rating}) over ${s.objects} customer objects, ${s.highDifficulty} high-difficulty.`);
  console.log(`${audit.findings.length} findings, ${audit.errors.length} read errors. Snapshot: ${LATEST}`);
} finally {
  await closeClient();
}
