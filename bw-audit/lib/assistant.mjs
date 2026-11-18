// What both chat routes share: the system prompt and the audit_query tool.

export const AUDIT_TOOL = {
  name: 'audit_query',
  description:
    'Query the audit snapshot shown in the web interface: scored BW objects with their difficulty (1-5), ' +
    'category, origin (custom or SAP content), flags and the reasons for the score. Use it before calling the ' +
    'live BW tools, to find which objects matter. Returns at most `limit` objects, hardest first.',
  input_schema: {
    type: 'object',
    properties: {
      type: { type: 'string', description: 'Object type: ADSO, CUBE, ODSO, MPRO, HCPR, TRFN, DTPA, RSPC, QUERY, VARIABLE, AFO, ALVL, LSYS' },
      category: { type: 'string', enum: ['storage', 'logic', 'extraction', 'orchestration', 'reporting', 'planning'] },
      min_difficulty: { type: 'integer', minimum: 1, maximum: 5 },
      name_contains: { type: 'string', description: 'Case-insensitive part of the technical name or description' },
      include_sap: { type: 'boolean', description: 'Include SAP-delivered content (default false)' },
      flag: { type: 'string', description: 'Only objects with this flag, e.g. "never loaded", "never run", "last run failed", "inactive"' },
      include_details: { type: 'boolean', description: 'Include the raw parsed details of each object (default false)' },
      limit: { type: 'integer', minimum: 1, maximum: 200 },
    },
    additionalProperties: false,
  },
};

export function runAuditQuery(audit, input = {}) {
  if (!audit) return 'No audit snapshot yet. Ask the user to run the audit first.';
  let items = audit.objects.filter((o) => o.difficulty);
  if (!input.include_sap) items = items.filter((o) => o.origin !== 'sap');
  if (input.type) items = items.filter((o) => o.type === input.type.toUpperCase());
  if (input.category) items = items.filter((o) => o.category === input.category);
  if (input.min_difficulty) items = items.filter((o) => o.difficulty >= input.min_difficulty);
  if (input.flag) items = items.filter((o) => o.flags.includes(input.flag));
  if (input.name_contains) {
    const q = input.name_contains.toLowerCase();
    items = items.filter((o) => o.name.toLowerCase().includes(q) || (o.description || '').toLowerCase().includes(q));
  }
  items.sort((a, b) => b.difficulty - a.difficulty || a.name.localeCompare(b.name));
  const limit = input.limit || 50;
  const out = items.slice(0, limit).map((o) => ({
    type: o.type, name: o.name, description: o.description, status: o.status, origin: o.origin,
    category: o.category, difficulty: o.difficulty, flags: o.flags, reasons: o.reasons,
    ...(input.include_details ? { details: o.details } : {}),
  }));
  return JSON.stringify({ matched: items.length, returned: out.length, objects: out });
}

function auditDigest(audit) {
  if (!audit) return 'No audit has been run yet.';
  const s = audit.summary;
  const hardest = audit.objects
    .filter((o) => o.difficulty >= 3 && o.origin === 'custom')
    .sort((a, b) => b.difficulty - a.difficulty)
    .slice(0, 40)
    .map((o) => `- ${o.type} ${o.name} (difficulty ${o.difficulty}${o.flags.length ? `, ${o.flags.join(', ')}` : ''}): ${o.reasons.join('; ')}`);
  return [
    `Audit snapshot taken ${audit.generatedAt}.`,
    `Scores are computed for the target: ${audit.target?.label || 'Generic platform'}${audit.target?.description ? ` (${audit.target.description})` : ''}.`,
    `System: ${JSON.stringify(audit.system)}`,
    `Inventory (total / customer / SAP content / inactive): ${Object.entries(audit.inventory).map(([k, v]) => `${k} ${v.total}/${v.custom}/${v.sap}/${v.inactive}`).join(', ')}`,
    `Complexity index, customer objects: ${s.custom.index}/100 (${s.custom.rating}), ${s.custom.objects} scored objects, ${s.custom.highDifficulty} with difficulty >= 4.`,
    `Complexity index including SAP content: ${s.all.index}/100 (${s.all.rating}), ${s.all.objects} objects.`,
    `Per category (customer scope): ${s.custom.byCategory.map((c) => `${c.label} ${c.count} objects avg ${c.average}`).join('; ')}`,
    'Findings:',
    ...audit.findings.map((f) => `- [${f.severity}] ${f.title}: ${f.objects.length} object(s). ${f.detail}`),
    'Hardest customer objects:',
    ...(hardest.length ? hardest : ['- none at difficulty 3 or more']),
  ].join('\n');
}

function targetInstruction(audit) {
  const t = audit?.target;
  if (!t || t.key === 'generic') return 'The target platform is not decided; keep assessments platform-agnostic unless the user names one.';
  return `The user selected ${t.label} as the migration target (${t.description}). Assess and recommend for ${t.label}: name its services and how each BW object maps onto them. If the user asks about another platform, answer for that one.`;
}

export function systemPrompt(audit) {
  return `You are a senior SAP BW migration architect working inside a web interface that shows an audit of a SAP BW system and how hard it would be to migrate to another data platform. ${targetInstruction(audit)}

The interface shows a difficulty from 1 (lift and shift) to 5 (redesign) for each object, computed by fixed rules from BW metadata. You can:
- query the audit snapshot with audit_query;
- read the live BW system with the bw_* tools (read-only). Use them to go deeper than the snapshot: transformation rules and ABAP routines (bw_find operation=metadata_tables object_type=TRFN), process chains (RSPC, RSPCLOG), providers (ADSO via bw_read, CUBE/ODSO/MPRO via metadata_tables), queries and variables (bw_read), data flow (bw_find operation=xref), and query usage (bw_monitor). bw_describe gives the parameters of any operation.

Ground every claim in what the audit or a tool returned, and name the objects by technical name. When you read ABAP, explain what it does in business terms and how it would be rebuilt on the target (SQL, a dbt model, a notebook, a lookup join, a parameter). If the rules' score looks wrong after a closer look, say so and why. When effort estimates are asked for, give ranges and state assumptions. Answer in the language the user writes in. Use Markdown; keep tables small.

The audit snapshot:
${auditDigest(audit)}`;
}
