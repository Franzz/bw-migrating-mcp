// Runs the audit against the BW system through bw-mcp and writes a JSON snapshot.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { callTool } from './mcp.mjs';
import * as P from './parse.mjs';
import { scoreObject, summarize, CATEGORIES, LEVELS } from './score.mjs';
import { getTarget, targetList } from './targets.mjs';
import { assignDomains } from './domains.mjs';
import { buildArchitecture } from './architecture.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.resolve(here, '..', 'data');
export const LATEST = path.join(DATA_DIR, 'latest.json');

const SEARCH_TYPES = ['AREA', 'ADSO', 'ODSO', 'CUBE', 'MPRO', 'HCPR', 'TRFN', 'DTPA', 'RSDS', 'TRCS', 'IOBJ', 'ELEM', 'ALVL', 'RSPC', 'DEST'];
const TYPE_LABELS = {
  AREA: 'InfoAreas', ADSO: 'Advanced DSOs', ODSO: 'Classic DSOs', CUBE: 'InfoCubes', MPRO: 'MultiProviders',
  HCPR: 'CompositeProviders', TRFN: 'Transformations', DTPA: 'DTPs', RSDS: 'DataSources', TRCS: 'InfoSources',
  IOBJ: 'InfoObjects', QUERY: 'Queries', VARIABLE: 'Variables', CKF: 'Calculated key figures',
  RKF: 'Restricted key figures', FILTER: 'Filters', ALVL: 'Aggregation levels', RSPC: 'Process chains',
  DEST: 'Open Hub destinations', LSYS: 'Source systems', AFO: 'AfO workbooks',
};
const MASTER_DATA_LABEL = 'Master data InfoObjects (loaded)';

async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/** "ADSO ADSO_ODS -> ADSO TARGET2" or "RSDS DS_ODS    U03_HANA -> ADSO ODSTOADS" */
function parseFlowDescription(desc = '') {
  const m = desc.match(/^(\w{4})\s+(\S+)(?:\s+(\S+))?\s*->\s*(\w{4})\s+(\S+)/);
  if (!m) return null;
  return {
    source: { type: m[1], name: m[2], sourceSystem: m[1] === 'RSDS' ? m[3] || null : null },
    target: { type: m[4], name: m[5] },
  };
}

export async function runAudit({ onProgress = () => {}, concurrency = 4, target: targetKey } = {}) {
  const target = getTarget(targetKey).key;
  const started = Date.now();
  const errors = [];
  const progress = (step, detail, pct) => onProgress({ step, detail, pct });
  const safe = async (label, fn, fallback = null) => {
    try { return await fn(); } catch (err) {
      errors.push({ where: label, message: String(err.message || err).slice(0, 400) });
      return fallback;
    }
  };

  progress('system', 'Reading the system profile', 2);
  const profileText = await callTool('bw_find', { operation: 'system_profile' });
  const system = P.parseSystemProfile(profileText);

  progress('inventory', 'Listing source systems', 5);
  const lsys = await safe('source_systems', async () =>
    JSON.parse(await callTool('bw_find', { operation: 'source_systems' })).source_systems, []);

  const search = {};
  let i = 0;
  for (const type of SEARCH_TYPES) {
    progress('inventory', `Searching ${TYPE_LABELS[type] || type}`, 5 + Math.round((i++ / SEARCH_TYPES.length) * 15));
    search[type] = await safe(`search ${type}`, async () =>
      P.parseSearch(await callTool('bw_find', { operation: 'search', search_term: '*', object_type: type })), []);
  }

  const chainStatus = await safe('RSPCLOG *', async () =>
    P.parseChainStatus(await callTool('bw_find', { operation: 'metadata_tables', object_type: 'RSPCLOG', object_name: '*' })), []);

  const workbooks = await safe('afo_workbooks', async () =>
    P.parseWorkbooks(await callTool('bw_find', { operation: 'afo_workbooks', max_results: 1000 })), []);

  const anpr = await safe('ANPR *', async () => {
    const t = await callTool('bw_find', { operation: 'metadata_tables', object_type: 'ANPR', object_name: '*' });
    return /No analysis process/i.test(t) ? [] : t.split('\n').filter((l) => /^\s+\S+\s{2,}/.test(l)).map((l) => l.trim().split(/\s{2,}/)[0]);
  }, []);

  progress('inventory', 'Reading the InfoArea tree', 20);
  const areas = await pool(search.AREA, concurrency, (a) => safe(`area ${a.name}`, async () => {
    const r = JSON.parse(await callTool('bw_read', { type: 'area', name: a.name }));
    return { name: a.name, label: r.label || a.description || a.name, parent: r.parent_area || null };
  }, { name: a.name, label: a.description || a.name, parent: null }));

  // InfoSources are not scored, but their InfoArea places the flows that end in them.
  const infoSources = (await pool(search.TRCS, concurrency, (t) => safe(`trcs ${t.name}`, async () => {
    const r = JSON.parse(await callTool('bw_read', { type: 'trcs', name: t.name }));
    return { name: t.name, infoArea: r.info_area || null };
  }, null))).filter(Boolean);

  // ---------- objects ----------
  const objects = [];
  const add = (o) => {
    const obj = {
      id: `${o.type}:${o.name}`,
      origin: P.isSapName(o.name) ? 'sap' : 'custom',
      status: 'active',
      details: {},
      flags: [],
      ...o,
    };
    if (obj.status && obj.status !== 'active') obj.flags.push('inactive');
    objects.push(obj);
    return obj;
  };

  for (const s of lsys) {
    add({ type: 'LSYS', name: s.name, description: s.description, origin: 'custom', status: 'active', details: { sourceSystemType: s.source_system_type } });
  }

  const detailJobs = [];
  for (const s of search.ADSO) {
    const o = add({ type: 'ADSO', name: s.name, description: s.description, status: s.status });
    detailJobs.push(async () => {
      const text = await callTool('bw_read', { type: 'adso', name: s.name });
      Object.assign(o.details, P.parseAdso(text));
      // The text output names fields, not the InfoObjects behind them: read those from the XML.
      o.details.infoObjects = await safe(`adso raw ${s.name}`, async () =>
        P.adsoInfoObjects(await callTool('bw_read', { type: 'adso', name: s.name, format: 'raw' })), []);
      if (o.details.createdBy === 'SAP') o.origin = 'sap';
      // No load history for aDSOs: on this release their requests are not in the
      // classic request store the metadata read covers, so "no requests" is not evidence.
    });
  }
  for (const type of ['CUBE', 'ODSO', 'MPRO']) {
    for (const s of search[type]) {
      const o = add({ type, name: s.name, description: s.description, status: s.status });
      detailJobs.push(async () => {
        const text = await callTool('bw_find', { operation: 'metadata_tables', object_type: type, object_name: s.name });
        Object.assign(o.details, P.parseProvider(text));
      });
    }
  }
  for (const s of search.HCPR) {
    const o = add({ type: 'HCPR', name: s.name, description: s.description, status: s.status });
    detailJobs.push(async () => {
      const h = JSON.parse(await callTool('bw_read', { type: 'hcpr', name: s.name }));
      o.details = {
        nodeType: h.view_node?.type || null,
        inputs: h.inputs?.length || 0,
        inputProviders: (h.inputs || []).map((x) => `${x.provider_type} ${x.name}`),
        infoObjects: [...new Set((h.fields?.list || []).filter((f) => !f.is_key_figure && f.info_object_name).map((f) => f.info_object_name))],
        fields: h.fields?.total || 0,
        join: h.join_condition ? `${h.join_condition.join_type} (${h.join_condition.cardinality})` : null,
        temporalJoin: !!h.temporal_join,
        infoArea: h.info_area,
      };
    });
  }
  for (const s of search.TRFN) {
    const flow = parseFlowDescription(s.description);
    const o = add({ type: 'TRFN', name: s.name, description: s.description, status: s.status });
    o.origin = flow && P.isSapName(flow.source.name) && P.isSapName(flow.target.name) ? 'sap' : 'custom';
    if (flow) o.details.flow = flow;
    detailJobs.push(async () => {
      const t = P.parseTransformation(await callTool('bw_find', { operation: 'metadata_tables', object_type: 'TRFN', object_name: s.name }));
      Object.assign(o.details, t);
      if (t.source && t.target) {
        o.details.flow = {
          source: { type: t.source.type, name: P.iobjName(t.source.name), sourceSystem: t.source.extra || o.details.flow?.source?.sourceSystem || null },
          target: { type: t.target.type, name: P.iobjName(t.target.name) },
        };
      }
    });
  }
  for (const s of search.DTPA) {
    const flow = parseFlowDescription(s.description);
    const o = add({ type: 'DTPA', name: s.name, description: s.description, status: s.status });
    o.origin = flow && P.isSapName(flow.source.name) && P.isSapName(flow.target.name) ? 'sap' : 'custom';
    if (flow) o.details.flow = flow;
  }
  const chainNames = new Set([...search.RSPC.map((s) => s.name), ...chainStatus.map((c) => c.chain)]);
  for (const name of chainNames) {
    const s = search.RSPC.find((x) => x.name === name);
    const st = chainStatus.find((c) => c.chain === name);
    const o = add({ type: 'RSPC', name, description: s?.description || '', status: s?.status || 'active', details: { lastRun: st || null } });
    if (st?.color === 'none') o.flags.push('never run');
    if (st?.color === 'red') o.flags.push('last run failed');
    detailJobs.push(async () => {
      const c = P.parseChain(await callTool('bw_find', { operation: 'metadata_tables', object_type: 'RSPC', object_name: name }));
      o.details.steps = c.steps;
      if (!o.description) o.description = c.description || '';
    });
  }

  const elemBySubtype = {};
  for (const s of search.ELEM) (elemBySubtype[s.subtype || 'other'] ||= []).push(s);
  for (const s of elemBySubtype.query || []) {
    const o = add({ type: 'QUERY', name: s.name, description: s.description, status: s.status });
    if (o.origin === 'custom') {
      detailJobs.push(async () => {
        Object.assign(o.details, P.parseQuery(await callTool('bw_read', { type: 'query', name: s.name })));
        if (o.details.changedBy === 'SAP' || P.isSapName(o.details.provider || '')) o.origin = 'sap';
      });
    }
  }
  for (const s of elemBySubtype.variable || []) {
    const o = add({ type: 'VARIABLE', name: s.name, description: s.description, status: s.status });
    if (o.origin === 'custom') {
      detailJobs.push(async () => {
        const v = JSON.parse(await callTool('bw_read', { type: 'variable', name: s.name }));
        o.details = { processing_type: v.processing_type, variable_type: v.variable_type, info_object: v.info_object, package: v.package };
        if (v.created_by === 'SAP') o.origin = 'sap';
      });
    }
  }
  for (const w of workbooks) {
    add({ type: 'AFO', name: w.name, description: w.description, origin: w.changedBy === 'SAP' || P.isSapName(w.name) ? 'sap' : 'custom', details: w });
  }
  for (const s of search.ALVL) {
    const o = add({ type: 'ALVL', name: s.name, description: s.description, status: s.status });
    detailJobs.push(async () => {
      Object.assign(o.details, P.parseAggregationLevel(await callTool('bw_read', { type: 'alvl', name: s.name })));
    });
  }

  progress('details', `Reading ${detailJobs.length} object definitions`, 22);
  let done = 0;
  await pool(detailJobs, concurrency, async (job, n) => {
    await safe(`detail #${n}`, job);
    done++;
    if (done % 5 === 0 || done === detailJobs.length) {
      progress('details', `Read ${done} of ${detailJobs.length} object definitions`, 22 + Math.round((done / detailJobs.length) * 70));
    }
  });

  // ---------- master data ----------
  // InfoObjects that a transformation loads or reads carry master data handled in BW:
  // they become objects of their own, assigned to the domain that uses them most.
  const iobjSearch = new Map(search.IOBJ.map((x) => [x.name, x]));
  const mdNames = new Set();
  for (const o of objects.filter((x) => x.type === 'TRFN' && x.details.flow)) {
    for (const ep of [o.details.flow.source, o.details.flow.target]) {
      if (ep.type !== 'IOBJ') continue;
      const name = iobjSearch.has(ep.name) ? ep.name : [...iobjSearch.keys()].find((k) => k.startsWith(ep.name));
      if (name) mdNames.add(name);
    }
  }
  progress('details', `Reading ${mdNames.size} master data InfoObject(s)`, 93);
  await pool([...mdNames], concurrency, (name) => safe(`iobj ${name}`, async () => {
    const s = iobjSearch.get(name);
    const o = add({ type: 'IOBJ', name, description: s.description, status: s.status });
    Object.assign(o.details, P.parseInfoObject(await callTool('bw_read', { type: 'iobj', name })));
    if (o.details.createdBy === 'SAP') o.origin = 'sap';
  }));

  // ---------- derived flags ----------
  const byId = new Map(objects.map((o) => [o.id, o]));
  for (const o of objects.filter((x) => x.type === 'MPRO')) {
    for (const part of o.details.parts || []) {
      const p = byId.get(`${part.type}:${part.name}`);
      part.virtual = /virtual/i.test(p?.details?.providerType || '');
    }
  }
  for (const o of objects) {
    const virtual = /virtual/i.test(o.details.providerType || '');
    if (['CUBE', 'ODSO'].includes(o.type) && !virtual && o.details.requests === 0) o.flags.push('never loaded');
  }

  // Domains first: the master data score uses how many domains share an InfoObject.
  const { domains } = assignDomains(objects, areas, { infoSources });
  const scored = objects.map((o) => scoreObject(o, target));

  // ---------- lineage ----------
  const flows = scored.filter((o) => o.type === 'TRFN' && o.details.flow).map((t) => {
    const dtps = scored.filter((d) => d.type === 'DTPA' && d.details.flow
      && d.details.flow.source.name === t.details.flow.source.name
      && d.details.flow.target.name.startsWith(t.details.flow.target.name.slice(0, 8)));
    return {
      transformation: t.name, status: t.status, difficulty: t.difficulty, origin: t.origin,
      source: t.details.flow.source, target: t.details.flow.target,
      dtps: dtps.map((d) => ({ name: d.name, status: d.status })),
      routines: (t.details.routines || []).map((r) => r.kind), abapLines: t.details.abapLines || 0,
    };
  });

  // ---------- inventory ----------
  const inventory = {};
  const count = (type, list) => {
    inventory[type] = {
      label: TYPE_LABELS[type] || type,
      total: list.length,
      custom: list.filter((x) => x.origin === 'custom').length,
      sap: list.filter((x) => x.origin === 'sap').length,
      inactive: list.filter((x) => x.status && x.status !== 'active').length,
    };
  };
  for (const type of ['ADSO', 'ODSO', 'CUBE', 'MPRO', 'HCPR', 'TRFN', 'DTPA', 'RSPC', 'QUERY', 'VARIABLE', 'AFO', 'ALVL', 'LSYS']) {
    count(type, scored.filter((o) => o.type === type));
  }
  count('IOBJ_MD', scored.filter((o) => o.type === 'IOBJ'));
  inventory.IOBJ_MD.label = MASTER_DATA_LABEL;
  for (const type of ['AREA', 'RSDS', 'TRCS', 'IOBJ', 'DEST']) {
    count(type, (search[type] || []).map((s) => ({ ...s, origin: P.isSapName(s.name) ? 'sap' : 'custom' })));
  }
  for (const sub of ['ckf', 'rkf', 'filter']) {
    count(sub.toUpperCase(), (elemBySubtype[sub] || []).map((s) => ({ ...s, origin: P.isSapName(s.name) ? 'sap' : 'custom' })));
  }
  if (anpr.length) inventory.ANPR = { label: 'Analysis processes', total: anpr.length, custom: anpr.length, sap: 0, inactive: 0 };

  const audit = {
    version: 2,
    target: describeTarget(target),
    generatedAt: new Date().toISOString(),
    durationSec: Math.round((Date.now() - started) / 1000),
    system,
    levels: LEVELS,
    categories: CATEGORIES,
    domains,
    areas,
    inventory,
    objects: scored,
    flows,
    summary: { custom: summarize(scored, { domains }), all: summarize(scored, { includeSap: true, domains }) },
    architecture: buildArchitecture(scored, domains, target),
    findings: buildFindings(scored, system, target),
    errors,
  };

  progress('save', 'Saving the snapshot', 96);
  await fs.mkdir(DATA_DIR, { recursive: true });
  const stamp = audit.generatedAt.replace(/[:.]/g, '-');
  const json = JSON.stringify(audit, null, 1);
  await fs.writeFile(path.join(DATA_DIR, `audit-${stamp}.json`), json);
  await fs.writeFile(LATEST, json);
  progress('done', `Audit complete in ${audit.durationSec}s`, 100);
  return audit;
}

function describeTarget(key) {
  return targetList().find((t) => t.key === key);
}

/**
 * Re-score a snapshot for another target. The BW metadata in the snapshot is all the
 * rules need, so switching target does not re-read BW.
 */
export function applyTarget(audit, targetKey) {
  if (!audit) return audit;
  const target = getTarget(targetKey).key;
  if (audit.target?.key === target) return audit;
  const objects = audit.objects.map((o) => scoreObject(o, target));
  const trfn = new Map(objects.filter((o) => o.type === 'TRFN').map((o) => [o.name, o.difficulty]));
  return {
    ...audit,
    target: describeTarget(target),
    objects,
    flows: audit.flows.map((fl) => ({ ...fl, difficulty: trfn.get(fl.transformation) ?? fl.difficulty })),
    summary: { custom: summarize(objects, { domains: audit.domains }), all: summarize(objects, { includeSap: true, domains: audit.domains }) },
    architecture: buildArchitecture(objects, audit.domains, target),
    findings: buildFindings(objects, audit.system, target),
  };
}

function buildFindings(objects, system, targetKey) {
  // Findings list every matching object, SAP content included; the UI filters by scope.
  // A target can replace the detail text of a finding (targets.mjs, findings[key]).
  const notes = getTarget(targetKey).findings;
  const custom = objects;
  const f = [];
  const push = (severity, title, detail, items, category, key) => {
    if (items.length) f.push({ severity, title, detail: (key && notes[key]) || detail, category, objects: items.map((o) => o.id) });
  };
  const trfn = custom.filter((o) => o.type === 'TRFN');
  push('critical', 'Expert routines',
    'The whole transformation is ABAP. It has to be rewritten by hand in SQL or Python, and reconciled against BW output.',
    trfn.filter((o) => o.details.routines?.some((r) => r.kind === 'expert')), 'logic', 'expert');
  push('serious', 'Transformations with start/end routines',
    'Package-level ABAP that filters, enriches or aggregates data. Its intent has to be reverse-engineered before it is rebuilt.',
    trfn.filter((o) => o.details.routines?.some((r) => r.kind === 'start' || r.kind === 'end')), 'logic', 'startEnd');
  push('warning', 'Field routines in ABAP',
    'Field-level ABAP. Most of it ports to SQL CASE expressions or functions, but each needs review and a test.',
    trfn.filter((o) => o.details.routines?.some((r) => r.kind === 'field')), 'logic');
  push('serious', 'ABAP that reads the database or calls function modules',
    'Lookups in ABAP (SELECT, function modules, master data) become joins against tables that must also be migrated.',
    trfn.filter((o) => o.details.patterns?.some((p) => ['db_select', 'call_function', 'master_data'].includes(p.key))), 'logic');

  const classic = custom.filter((o) => ['CUBE', 'ODSO', 'MPRO'].includes(o.type));
  push('warning', 'Classic (3.x/7.x) providers',
    'InfoCubes, classic DSOs and MultiProviders have no BW/4HANA or data-platform equivalent and must be remodeled.',
    classic, 'storage', 'classic');
  push('serious', 'Virtual providers with ABAP or HANA logic',
    'Data is computed at query time by a function module or HANA model. That logic is not visible in the BW metadata and must be analysed separately.',
    objects.filter((o) => o.type === 'CUBE' && /virtual/i.test(o.details.providerType || '')), 'storage');

  push('serious', 'Customer exit variables',
    'Variable values computed in ABAP (customer exit / BAdI). Re-implement them as parameters with logic in the BI tool or the model.',
    custom.filter((o) => o.type === 'VARIABLE' && o.details.processing_type === 'CustomerExit'), 'reporting', 'customerExit');
  push('warning', 'Authorization variables',
    'They depend on BW analysis authorizations. Row-level security has to be redesigned on the target.',
    custom.filter((o) => o.type === 'VARIABLE' && o.details.processing_type === 'Authorization'), 'reporting', 'authVariables');

  const planning = objects.filter((o) => o.category === 'planning');
  push('critical', 'BW Integrated Planning in use',
    'Aggregation levels, planning sequences and planning workbooks have no equivalent on a generic data platform. Plan for a dedicated planning tool or keep BW-IP running.',
    planning, 'planning', 'planning');

  push('serious', 'Process chains whose last run failed',
    'Failing loads should be fixed or retired before their logic is migrated.',
    custom.filter((o) => o.type === 'RSPC' && o.flags.includes('last run failed')), 'orchestration');
  push('serious', 'BW Service API / ODP extraction',
    'SAP extractors (S-API, ODP) need an SAP-certified connector or replication tool on the target, and delta initialisation.',
    objects.filter((o) => o.type === 'LSYS' && /ODP|LSYS_BW/.test(o.details.sourceSystemType || '')), 'extraction', 'extraction');

  push('good', 'Decommission candidates',
    'Never loaded, never run or inactive. Confirm with the business, then leave them out of scope to reduce the migration.',
    custom.filter((o) => o.flags.some((x) => ['never loaded', 'never run', 'inactive'].includes(x))), 'scope');

  if (system.classic) {
    f.push({ severity: 'warning', title: 'Classic BW release', category: 'platform', objects: [],
      detail: `${system.platform}${system.serverVersion ? `, server ${system.serverVersion}` : ''}. Transformations, DTPs and process chains are only readable from metadata tables, and 3.x objects may still exist.` });
  }
  const order = { critical: 0, serious: 1, warning: 2, good: 3 };
  return f.sort((a, b) => order[a.severity] - order[b.severity]);
}

export async function readLatest() {
  try { return JSON.parse(await fs.readFile(LATEST, 'utf8')); } catch { return null; }
}
