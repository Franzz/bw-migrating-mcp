// Migration difficulty rules.
// Each object gets a difficulty from 1 (lift and shift) to 5 (redesign), with the reasons
// that produced it. The rules only use what the audit read; they never guess.
// The rules here are platform-agnostic; lib/targets.mjs adds per-target adjustments.
import { getTarget } from './targets.mjs';

export const LEVELS = {
  1: 'Trivial',
  2: 'Low',
  3: 'Medium',
  4: 'High',
  5: 'Redesign',
};

export const CATEGORIES = {
  storage: { label: 'Storage & providers', weight: 1.0 },
  masterdata: { label: 'Master data', weight: 0.8 },
  logic: { label: 'Transformation logic', weight: 1.5 },
  extraction: { label: 'Extraction & sources', weight: 1.2 },
  orchestration: { label: 'Orchestration', weight: 0.8 },
  reporting: { label: 'Reporting & front end', weight: 1.0 },
  planning: { label: 'Planning', weight: 1.5 },
};

const clamp = (n) => Math.max(1, Math.min(5, Math.round(n)));

function result(base, reasons) {
  let d = base;
  for (const r of reasons) d += r.points || 0;
  return { difficulty: clamp(d), raw: d, reasons: reasons.map((r) => r.text) };
}

export function scoreAdso(o) {
  const r = [{ text: 'aDSO: maps to a table in the target, keys and fields known' }];
  const d = o.details || {};
  if (d.adsoType && d.adsoType !== 'standard') r.push({ text: `aDSO type "${d.adsoType}"`, points: 0.5 });
  if (d.adsoType === 'standard') r.push({ text: 'Standard aDSO: activation, change log and delta semantics must be rebuilt (upsert/merge + change capture)', points: 1 });
  if (d.inventory) r.push({ text: 'Inventory (non-cumulative) key figures: stock logic must be re-implemented', points: 2 });
  if (d.planning) r.push({ text: 'Planning-enabled: direct write-back from planning', points: 2 });
  if (d.externalHanaView) r.push({ text: 'External HANA view consumed by other tools', points: 0.5 });
  return result(1, r);
}

export function scoreCube(o) {
  const d = o.details || {};
  const t = (d.providerType || '').toLowerCase();
  const r = [];
  if (t.includes('virtual')) {
    r.push({ text: `Virtual provider (${d.providerType}): data is computed at query time` });
    if (d.functionModule) r.push({ text: `Logic lives in ${d.functionModule}, which must be re-implemented as a view or service`, points: 1.5 });
    return result(3, r);
  }
  r.push({ text: 'Classic InfoCube: star schema with dimension tables must be flattened or remodeled' });
  if (t.includes('real') || t.includes('planning') || t.includes('transactional')) r.push({ text: 'Real-time (planning) InfoCube', points: 1.5 });
  if (d.dimensions > 10) r.push({ text: `${d.dimensions} dimensions`, points: 0.5 });
  return result(3, r);
}

export function scoreOdso(o) {
  return result(3, [{ text: 'Classic DSO: activation queue / change log semantics must be rebuilt in the target' }]);
}

export function scoreMpro(o) {
  const parts = o.details?.parts || [];
  const r = [{ text: `MultiProvider over ${parts.length} part provider(s): becomes a UNION view` }];
  const virtual = parts.filter((p) => p.type === 'CUBE' && p.virtual).length;
  if (virtual) r.push({ text: `${virtual} virtual part provider(s)`, points: 1 });
  if (parts.length > 4) r.push({ text: 'Many parts: field mapping to reconcile', points: 0.5 });
  return result(2, r);
}

export function scoreHcpr(o) {
  const d = o.details || {};
  const r = [{ text: 'CompositeProvider: becomes a SQL view' }];
  if (/join/i.test(d.nodeType || '')) r.push({ text: `Join node${d.join ? ` (${d.join})` : ''}: join conditions and cardinalities to reproduce`, points: 1 });
  if (d.temporalJoin) r.push({ text: 'Temporal join (time-dependent validity)', points: 1 });
  if ((d.inputs || 0) > 3) r.push({ text: `${d.inputs} inputs`, points: 0.5 });
  return result(2, r);
}

export function scoreMasterData(o) {
  const d = o.details || {};
  const r = [{ text: 'Master data InfoObject: becomes a dimension table (attributes) with its texts' }];
  if (d.timeDependent) r.push({ text: 'Time-dependent attributes or texts: validity periods to keep (slowly changing dimension, type 2)', points: 1 });
  if (d.hierarchies) r.push({ text: 'Hierarchies: parent-child hierarchy tables to rebuild and flatten for reporting', points: 1 });
  if (d.attributes > 15) r.push({ text: `${d.attributes} attributes`, points: 0.5 });
  const domains = Object.keys(d.usage || {}).length;
  if (domains > 1) r.push({ text: `Used in ${domains} domains: build once as a shared, conformed dimension`, points: 0.5 });
  return result(1.5, r);
}

export function scoreTransformation(o) {
  const d = o.details || {};
  const r = [];
  const kinds = new Set((d.routines || []).map((x) => x.kind));
  if (!d.routines?.length) r.push({ text: 'Only direct, constant and time mappings: generated as SQL' });
  if (kinds.has('expert')) r.push({ text: 'Expert routine: the whole transformation is ABAP, manual rewrite', points: 4 });
  if (kinds.has('start')) r.push({ text: 'Start routine (ABAP on the source package)', points: 1.5 });
  if (kinds.has('end')) r.push({ text: 'End routine (ABAP on the result package)', points: 1.5 });
  if (kinds.has('global')) r.push({ text: 'Global declarations shared across routines', points: 0.5 });
  const fieldRoutines = (d.routines || []).filter((x) => x.kind === 'field').length;
  if (fieldRoutines) r.push({ text: `${fieldRoutines} field routine(s) in ABAP`, points: fieldRoutines > 2 ? 1.5 : 1 });
  if (d.abapLines > 50) r.push({ text: `${d.abapLines} lines of ABAP`, points: d.abapLines > 200 ? 1.5 : 0.5 });
  for (const p of d.patterns || []) {
    if (['db_select', 'call_function', 'master_data', 'dynamic'].includes(p.key)) {
      r.push({ text: `ABAP uses ${p.label}`, points: 0.5 });
    }
  }
  const lookups = (d.ruleTypes?.LOOKUP || 0) + (d.ruleTypes?.READ || 0) + (d.ruleTypes?.MASTER || 0);
  if (lookups) r.push({ text: `${lookups} master data lookup rule(s): become joins`, points: 0.5 });
  if (d.ruleTypes?.FORMULA) r.push({ text: `${d.ruleTypes.FORMULA} formula rule(s)`, points: 0.25 });
  return result(1, r);
}

/** Update rules and transfer rules: the transformation rules, plus the cost of leaving 3.x. */
export function scoreFlow3x(o) {
  const d = o.details || {};
  const rules = d.ruleTypes || {};
  const base = scoreTransformation({ ...o, details: { ...d, ruleTypes: { MASTER: rules.MASTER_DATA_READ || 0, FORMULA: rules.FORMULA || 0 } } });
  const kind = o.type === 'UPDR' ? 'Update rules' : 'Transfer rules';
  const r = [{ text: `${kind} (3.x data flow): no successor outside BW 3.x, the logic is rebuilt or first migrated to a transformation`, points: 1 }];
  if (d.expertMode) r.push({ text: 'Expert mode: the whole update is ABAP', points: 2 });
  const raw = base.raw + r.reduce((n, x) => n + x.points, 0);
  return { difficulty: clamp(raw), raw, reasons: [...r.map((x) => x.text), ...base.reasons] };
}

export function scoreDataSource3x(o) {
  return result(2, [{ text: '3.x DataSource: extraction is rebuilt on an ODP-based source (or the DataSource migrated to the 7.x type first)' }]);
}

export function scoreDtp(o) {
  return result(1, [{ text: 'DTP: load step, becomes a pipeline/model run (filters and delta reproduced)' }]);
}

export function scoreSourceSystem(o) {
  const t = o.details?.sourceSystemType || '';
  const map = {
    LSYS_FILE: [2, 'Flat-file source: re-point ingestion to files on object storage'],
    LSYS_ODP_SAP: [3, 'ODP (SAP extractors): needs an SAP connector or replication tool; delta queues must be re-initialised'],
    LSYS_ODP_BW: [3, 'ODP BW source: needs an SAP connector'],
    LSYS_BW: [4, 'SAP source through the BW Service API (RFC, myself/S-API extractors): extractor logic and delta handling must be replaced'],
    LSYS_HANADB: [2, 'SAP HANA (SDA) source: direct database connection, tables/views can be read by the target'],
    LSYS_DB: [2, 'DB Connect source'],
    LSYS_WS: [3, 'Web service / push source'],
  };
  const [base, text] = map[t] || [3, `Source system type ${t || 'unknown'}`];
  return result(base, [{ text }]);
}

export function scoreChain(o) {
  const steps = o.details?.steps || [];
  const r = [{ text: `${steps.length} step(s): rebuilt in the target orchestrator` }];
  const abap = steps.filter((s) => /ABAP|PROGRAM|ABAPV/.test(s.processType)).length;
  const decision = steps.filter((s) => /DECISION|DECI/.test(s.processType)).length;
  const special = steps.filter((s) => /ODSACTIVAT|ADSOACT|DROPCUBE|DELTA|CHANGERUN|ATTRIB|REPA|DELREQ/.test(s.processType)).length;
  if (abap) r.push({ text: `${abap} ABAP program step(s)`, points: 1.5 });
  if (decision) r.push({ text: `${decision} decision step(s) with formulas`, points: 1 });
  if (special) r.push({ text: `${special} BW housekeeping step(s) (activation, change run, deletion) with no direct equivalent`, points: 0.5 });
  if (steps.length > 15) r.push({ text: 'Large chain', points: 0.5 });
  return result(1.5, r);
}

export function scoreQuery(o) {
  const d = o.details || {};
  const r = [{ text: 'BEx query: rebuilt as a semantic model / BI report' }];
  const calc = (d.ckf || 0) + (d.rkf || 0);
  if (calc > 0) r.push({ text: `${calc} calculated/restricted key figure(s)`, points: calc > 5 ? 1 : 0.5 });
  if (d.exceptions) r.push({ text: `${d.exceptions} exception(s) (conditional formatting)`, points: 0.5 });
  if (d.cells) r.push({ text: 'Cell definitions: cell-level formulas have no generic equivalent', points: 1.5 });
  if (d.variables > 3) r.push({ text: `${d.variables} variables`, points: 0.5 });
  if (d.hasHierarchy) r.push({ text: 'Uses hierarchies', points: 0.5 });
  return result(2, r);
}

export function scoreVariable(o) {
  const p = o.details?.processing_type || '';
  const map = {
    UserEntry: [1, 'User-entry variable: becomes a report parameter'],
    ReplacementPath: [2, 'Replacement path: derived from another value or query result'],
    CustomerExit: [4, 'Customer exit variable: value computed in ABAP (RSR00001 / BAdI), must be re-implemented'],
    SAPExit: [3, 'SAP exit variable: SAP-delivered logic (e.g. current period) to reproduce'],
    Authorization: [3, 'Authorization variable: depends on the BW analysis authorization model'],
  };
  const [base, text] = map[p] || [2, `Processing type ${p || 'unknown'}`];
  return result(base, [{ text }]);
}

export function scoreWorkbook(o) {
  const d = o.details || {};
  const r = [{ text: `Analysis for Office workbook over ${d.queries?.length || 0} query data source(s): front end to rebuild` }];
  if (d.planning?.length) r.push({ text: `Planning workbook: ${d.planning.length} planning sequence/function trigger(s)`, points: 1.5 });
  return result(3, r);
}

export function scoreAggregationLevel(o) {
  return result(4, [{ text: 'BW-IP aggregation level: integrated planning has no generic equivalent on a data platform (needs a planning tool)' }]);
}

const SCORERS = {
  ADSO: ['storage', scoreAdso],
  CUBE: ['storage', scoreCube],
  ODSO: ['storage', scoreOdso],
  MPRO: ['storage', scoreMpro],
  HCPR: ['storage', scoreHcpr],
  IOBJ: ['masterdata', scoreMasterData],
  TRFN: ['logic', scoreTransformation],
  DTPA: ['logic', scoreDtp],
  UPDR: ['logic', scoreFlow3x],
  ISTS: ['logic', scoreFlow3x],
  ISFS: ['extraction', scoreDataSource3x],
  LSYS: ['extraction', scoreSourceSystem],
  RSPC: ['orchestration', scoreChain],
  QUERY: ['reporting', scoreQuery],
  VARIABLE: ['reporting', scoreVariable],
  AFO: ['reporting', scoreWorkbook],
  ALVL: ['planning', scoreAggregationLevel],
};

/** Score one object for a target (lib/targets.mjs key; unknown or omitted = generic). */
export function scoreObject(o, targetKey) {
  const target = getTarget(typeof targetKey === 'string' ? targetKey : undefined);
  const entry = SCORERS[o.type];
  if (!entry) return o;
  const [category, fn] = entry;
  let category2 = category;
  if (o.type === 'CUBE' && /real|planning/i.test(o.details?.providerType || '')) category2 = 'planning';
  if (o.type === 'AFO' && o.details?.planning?.length) category2 = 'planning';
  if (o.type === 'ADSO' && o.details?.planning) category2 = 'planning';
  const base = fn(o);
  const extra = target.adjust[o.type]?.(o) || [];
  // Start from the bounded, unrounded base so adjustments are not lost above 5 or below 1.
  let raw = Math.max(1, Math.min(5, base.raw));
  for (const r of extra) raw += r.points || 0;
  return { ...o, category: category2, difficulty: clamp(raw), reasons: [...base.reasons, ...extra.map((r) => r.text)] };
}

const average = (items) => (items.length ? Math.round((items.reduce((n, o) => n + o.difficulty, 0) / items.length) * 10) / 10 : 0);

/** Average difficulty per domain (lib/domains.mjs), domains with objects only, largest first. */
export function summarizeDomains(scope, domains = {}) {
  const groups = new Map();
  for (const o of scope) {
    if (!o.domain) continue;
    if (!groups.has(o.domain)) groups.set(o.domain, []);
    groups.get(o.domain).push(o);
  }
  return [...groups.entries()].map(([key, items]) => ({
    key, label: domains[key]?.label || key, special: Boolean(domains[key]?.special),
    count: items.length, average: average(items), high: items.filter((o) => o.difficulty >= 4).length,
  })).sort((a, b) => a.special - b.special || b.count - a.count || a.label.localeCompare(b.label));
}

/** Aggregate scored objects. inScope filters (e.g. custom only). */
export function summarize(objects, { includeSap = false, domains } = {}) {
  const scope = objects.filter((o) => o.difficulty && (includeSap || o.origin !== 'sap'));
  const byCategory = {};
  for (const [key, meta] of Object.entries(CATEGORIES)) {
    const items = scope.filter((o) => o.category === key);
    const avg = items.length ? items.reduce((n, o) => n + o.difficulty, 0) / items.length : 0;
    byCategory[key] = {
      key, label: meta.label, count: items.length,
      average: Math.round(avg * 10) / 10,
      high: items.filter((o) => o.difficulty >= 4).length,
    };
  }
  const distribution = [1, 2, 3, 4, 5].map((level) => ({
    level, label: LEVELS[level], count: scope.filter((o) => o.difficulty === level).length,
  }));
  // Complexity index: category averages weighted by category weight and by how many
  // objects they hold (log-damped, so 300 queries do not drown 10 routines).
  let num = 0;
  let den = 0;
  for (const c of Object.values(byCategory)) {
    if (!c.count) continue;
    const w = CATEGORIES[c.key].weight * Math.log2(1 + c.count);
    num += w * (c.average - 1) / 4;
    den += w;
  }
  const index = den ? Math.round((num / den) * 100) : 0;
  const rating = index >= 70 ? 'Very high' : index >= 50 ? 'High' : index >= 30 ? 'Moderate' : 'Low';
  return {
    scope: includeSap ? 'all' : 'custom',
    objects: scope.length,
    index, rating,
    highDifficulty: scope.filter((o) => o.difficulty >= 4).length,
    byCategory: Object.values(byCategory),
    byDomain: summarizeDomains(scope, domains),
    distribution,
  };
}
