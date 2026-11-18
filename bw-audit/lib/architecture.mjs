// Target architecture per domain. For a chosen target platform, each domain (top-level
// InfoArea, see domains.mjs) gets a container on the target and a set of layers, each
// naming the target component and the BW objects of the domain that land in it.
// Like the scoring rules, it only uses what the audit read. The generic target has none.
import { CROSS, UNASSIGNED } from './domains.mjs';
import { getTarget } from './targets.mjs';

const LAYERS = [
  { key: 'ingest', label: 'Ingestion', types: ['LSYS'] },
  { key: 'integration', label: 'Integration', types: ['TRFN', 'DTPA', 'ADSO', 'ODSO'] },
  { key: 'masterdata', label: 'Master data', types: ['IOBJ'] },
  { key: 'marts', label: 'Business layer', types: ['CUBE', 'MPRO', 'HCPR'] },
  { key: 'semantic', label: 'Semantic & reporting', types: ['QUERY', 'VARIABLE', 'AFO'] },
  { key: 'planning', label: 'Planning', types: ['ALVL'] },
  { key: 'orchestration', label: 'Orchestration', types: ['RSPC'] },
];

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const slug = (key) => key.replace(/^\/|\/$/g, '').replace(/[^A-Za-z0-9]+/g, '_').toUpperCase();

/** What the architecture rules need to know about one domain. */
function stats(items, all) {
  const byType = {};
  for (const o of items) (byType[o.type] ||= []).push(o);
  const n = (t) => (byType[t] || []).length;
  const trfn = byType.TRFN || [];
  const lsysByName = new Map(all.filter((o) => o.type === 'LSYS').map((o) => [o.name, o]));
  // Source systems that feed this domain: its own LSYS plus those behind its flows.
  const feeding = new Map((byType.LSYS || []).map((o) => [o.name, o]));
  for (const f of [...trfn, ...(byType.DTPA || [])]) {
    const ss = f.details?.flow?.source?.sourceSystem;
    if (ss && lsysByName.has(ss)) feeding.set(ss, lsysByName.get(ss));
  }
  const sourceTypes = new Set([...feeding.values()].map((o) => o.details?.sourceSystemType || ''));
  const cubes = byType.CUBE || [];
  const vars = byType.VARIABLE || [];
  const queries = byType.QUERY || [];
  const iobj = byType.IOBJ || [];
  return {
    n, byType, feeding: [...feeding.values()],
    odp: [...sourceTypes].some((t) => /ODP/.test(t)),
    sapi: sourceTypes.has('LSYS_BW'),
    hana: sourceTypes.has('LSYS_HANADB'),
    file: sourceTypes.has('LSYS_FILE'),
    otherSource: [...sourceTypes].some((t) => !/ODP|LSYS_BW|LSYS_HANADB|LSYS_FILE/.test(t)),
    rsds: new Set(trfn.filter((t) => t.details?.flow?.source?.type === 'RSDS').map((t) => t.details.flow.source.name)).size,
    routines: trfn.filter((t) => t.details?.routines?.length).length,
    expert: trfn.filter((t) => t.details?.routines?.some((r) => r.kind === 'expert')).length,
    abapLines: trfn.reduce((s, t) => s + (t.details?.abapLines || 0), 0),
    standardAdso: (byType.ADSO || []).filter((o) => o.details?.adsoType === 'standard').length + n('ODSO'),
    inventory: (byType.ADSO || []).filter((o) => o.details?.inventory).length,
    virtual: cubes.filter((o) => /virtual/i.test(o.details?.providerType || '')).length,
    realCubes: cubes.filter((o) => !/virtual/i.test(o.details?.providerType || '')).length,
    hierarchies: iobj.filter((o) => o.details?.hierarchies).length,
    timeDep: iobj.filter((o) => o.details?.timeDependent).length,
    sharedMd: iobj.filter((o) => Object.keys(o.details?.usage || {}).length > 1).length,
    measures: queries.reduce((s, q) => s + (q.details?.ckf || 0) + (q.details?.rkf || 0), 0),
    authVars: vars.filter((v) => v.details?.processing_type === 'Authorization').length,
    exitVars: vars.filter((v) => v.details?.processing_type === 'CustomerExit').length,
    planning: items.filter((o) => o.category === 'planning').length,
    decom: items.filter((o) => o.flags?.some((f) => ['never loaded', 'never run', 'inactive'].includes(f))).length,
  };
}

const join = (parts) => parts.filter(Boolean).join(' ');

// Per target: the domain container and, per layer, { component, detail } (null = layer unused).
const BLUEPRINTS = {
  fabric: {
    container: (d, s) => d.key === CROSS
      ? 'A shared ingestion workspace: source connections and the bronze Lakehouse, exposed to the domain workspaces through OneLake shortcuts.'
      : `Fabric workspace ${slug(d.key)}: a Lakehouse for bronze and silver, a Warehouse (or gold Lakehouse) for the star schema, and the Power BI items of the domain${s.n('QUERY') || s.n('AFO') ? '' : ' when reporting is added'}.`,
    shared: 'Publish the shared dimensions once and reference them from the other domain workspaces through OneLake shortcuts.',
    ingest: (s) => ({
      component: 'Data Factory pipelines → bronze Lakehouse',
      detail: join([
        s.odp && 'SAP extractors (ODP) through the Data Factory SAP connectors and the on-premises data gateway, or SAP mirroring.',
        s.sapi && 'S-API extractors (BW Service API) are not readable as is: switch them to ODP or to the SAP Table connector.',
        s.hana && 'SAP HANA tables through the SAP HANA connector (gateway), or mirrored.',
        s.file && 'Flat files land in the Lakehouse Files area and load with a copy activity.',
        s.otherSource && 'Other sources through the matching Data Factory connector.',
      ]),
    }),
    integration: (s) => ({
      component: 'Silver Lakehouse (Delta tables)',
      detail: join([
        s.standardAdso && `${plural(s.standardAdso, 'DataStore object')} become Delta tables loaded with MERGE; change data feed replaces the change log.`,
        s.n('TRFN') && `${plural(s.n('TRFN'), 'transformation')} become T-SQL views or Dataflow Gen2 steps${s.routines ? `; the ${s.routines} with ABAP routines (${s.abapLines} lines) become Spark notebooks` : ''}.`,
        s.inventory && `${plural(s.inventory, 'inventory aDSO')}: stock (non-cumulative) logic rebuilt as snapshot tables.`,
      ]),
    }),
    masterdata: (s) => ({
      component: 'Conformed dimension tables (silver Lakehouse)',
      detail: join([
        `${plural(s.n('IOBJ'), 'master data InfoObject')} become dimension tables with their texts.`,
        s.timeDep && `${s.timeDep} time-dependent: keep validity columns (SCD type 2).`,
        s.hierarchies && `${s.hierarchies} with hierarchies: flattened level columns or parent-child DAX in Power BI.`,
      ]),
    }),
    marts: (s) => ({
      component: 'Warehouse star schema (gold)',
      detail: join([
        s.realCubes && `${plural(s.realCubes, 'InfoCube')} become fact tables.`,
        s.virtual && `${plural(s.virtual, 'virtual provider')}: views over the source, or shortcuts to mirrored tables.`,
        s.n('MPRO') && `${plural(s.n('MPRO'), 'MultiProvider')} become UNION views.`,
        s.n('HCPR') && `${plural(s.n('HCPR'), 'CompositeProvider')} become views with the same joins.`,
      ]),
    }),
    semantic: (s) => ({
      component: 'Power BI semantic model and reports',
      detail: join([
        s.n('QUERY') && `${plural(s.n('QUERY'), 'query', 'queries')} become reports on a semantic model per subject${s.measures ? `; ${s.measures} calculated/restricted key figures become DAX measures` : ''}.`,
        s.n('VARIABLE') && `${plural(s.n('VARIABLE'), 'variable')} become report parameters or slicers${s.exitVars ? ` (${s.exitVars} customer exits to re-implement)` : ''}.`,
        s.authVars && `${s.authVars} authorization variable(s): row-level security roles.`,
        s.n('AFO') && `${plural(s.n('AFO'), 'AfO workbook')}: Analyze in Excel over the semantic model.`,
      ]),
    }),
    planning: (s) => ({
      component: 'Third-party planning tool on Power BI',
      detail: `${plural(s.planning, 'planning object')}: Fabric has no integrated planning. Use a write-back or EPM tool on the semantic model, or keep BW-IP running for this domain.`,
    }),
    orchestration: (s) => ({
      component: 'Data Factory pipelines and schedules',
      detail: `${plural(s.n('RSPC'), 'process chain')} become pipelines; activation and change-run steps disappear with Delta.`,
    }),
  },

  'snowflake-dbt': {
    container: (d) => d.key === CROSS
      ? 'A shared RAW database fed by the replication tool, read by the domain databases (or shared to them).'
      : `Snowflake database ${slug(d.key)} with schemas RAW, STAGING, INTERMEDIATE and MARTS, and a dbt project folder models/${slug(d.key).toLowerCase()}.`,
    shared: 'Build the shared dimensions in one dbt project and expose them to the other domains (cross-database references or secure shares).',
    ingest: (s) => ({
      component: 'Replication tool → RAW schema',
      detail: join([
        (s.odp || s.sapi) && 'SAP extractors need a third-party replication tool (e.g. Fivetran, SNP Glue, Qlik Replicate); Snowflake has no SAP connector.',
        s.sapi && 'S-API extractors (BW Service API) should be switched to ODP first.',
        s.hana && 'SAP HANA tables replicated (no federation to HANA).',
        s.file && 'Flat files load from an external stage with COPY INTO or Snowpipe.',
      ]),
    }),
    integration: (s) => ({
      component: 'dbt staging and intermediate models',
      detail: join([
        s.standardAdso && `${plural(s.standardAdso, 'DataStore object')} become incremental models (merge); dbt snapshots or streams replace the change log.`,
        s.n('TRFN') && `${plural(s.n('TRFN'), 'transformation')} become SQL models with tests${s.routines ? `; the ${s.routines} with ABAP routines (${s.abapLines} lines) become SQL or Snowpark Python` : ''}.`,
        s.inventory && `${plural(s.inventory, 'inventory aDSO')}: stock logic rebuilt as snapshot models.`,
      ]),
    }),
    masterdata: (s) => ({
      component: 'dbt dimension models',
      detail: join([
        `${plural(s.n('IOBJ'), 'master data InfoObject')} become dimension models with their texts.`,
        s.timeDep && `${s.timeDep} time-dependent: dbt snapshots (SCD type 2).`,
        s.hierarchies && `${s.hierarchies} with hierarchies: parent-child tables plus a flattened model.`,
      ]),
    }),
    marts: (s) => ({
      component: 'dbt marts (MARTS schema)',
      detail: join([
        s.realCubes && `${plural(s.realCubes, 'InfoCube')} become fact models.`,
        s.virtual && `${plural(s.virtual, 'virtual provider')}: the source must be replicated first.`,
        s.n('MPRO') && `${plural(s.n('MPRO'), 'MultiProvider')} become UNION ALL views.`,
        s.n('HCPR') && `${plural(s.n('HCPR'), 'CompositeProvider')} become view models, joins covered by dbt tests.`,
      ]),
    }),
    semantic: (s) => ({
      component: 'BI tool + dbt Semantic Layer or Snowflake semantic views',
      detail: join([
        s.n('QUERY') && `${plural(s.n('QUERY'), 'query', 'queries')} need a BI tool on a semantic layer${s.measures ? `; ${s.measures} calculated/restricted key figures become metrics` : ''}.`,
        s.n('VARIABLE') && `${plural(s.n('VARIABLE'), 'variable')} become BI parameters${s.exitVars ? ` (${s.exitVars} customer exits as dbt models or BI logic)` : ''}.`,
        s.authVars && `${s.authVars} authorization variable(s): Snowflake row access policies.`,
        s.n('AFO') && `${plural(s.n('AFO'), 'AfO workbook')}: rebuilt in the BI tool or Excel over ODBC.`,
      ]),
    }),
    planning: (s) => ({
      component: 'Separate planning tool',
      detail: `${plural(s.planning, 'planning object')}: no planning capability on Snowflake or dbt. Feed a planning tool from MARTS, or keep BW-IP running.`,
    }),
    orchestration: (s) => ({
      component: 'dbt Cloud jobs, Airflow or Snowflake tasks',
      detail: `${plural(s.n('RSPC'), 'process chain')}: dbt model dependencies replace the load steps; only scheduling remains.`,
    }),
  },

  datasphere: {
    container: (d, s) => d.key === CROSS
      ? 'A shared ingestion space holding the connections and replication flows, its tables shared to the domain spaces.'
      : `Datasphere space ${slug(d.key)}${s.routines || s.sapi || s.realCubes + s.n('ODSO') + s.n('MPRO') ? ', plus the SAP BW Bridge for the ABAP-based objects carried over' : ''}.`,
    shared: 'Model the shared dimensions in this space and share them to the other domain spaces.',
    ingest: (s) => ({
      component: 'Replication flows and remote tables',
      detail: join([
        s.odp && 'SAP extractors through replication flows on an SAP ABAP connection (ODP).',
        s.sapi && 'S-API extractors carried over in the BW Bridge, or switched to ODP replication flows.',
        s.hana && 'SAP HANA tables as remote tables, or replicated.',
        s.file && 'Flat files uploaded to local tables, or read from object storage by a replication flow.',
      ]),
    }),
    integration: (s) => ({
      component: 'Local tables and transformation flows',
      detail: join([
        s.standardAdso && `${plural(s.standardAdso, 'DataStore object')} become local tables with delta capture (or aDSOs in the BW Bridge).`,
        s.n('TRFN') && `${plural(s.n('TRFN'), 'transformation')} become transformation flows or views${s.routines ? `; the ${s.routines} with ABAP routines run unchanged in the BW Bridge, or are rewritten in SQLScript/Python` : ''}.`,
      ]),
    }),
    masterdata: (s) => ({
      component: 'Dimension views',
      detail: join([
        `${plural(s.n('IOBJ'), 'master data InfoObject')} become dimension views with text associations.`,
        s.hierarchies && `${s.hierarchies} with hierarchies: hierarchy (parent-child) associations.`,
        s.timeDep && `${s.timeDep} time-dependent: validity columns on the dimension.`,
      ]),
    }),
    marts: (s) => ({
      component: 'Fact views and analytic models',
      detail: join([
        s.realCubes && `${plural(s.realCubes, 'InfoCube')} become fact views (BW Bridge conversion possible).`,
        s.virtual && `${plural(s.virtual, 'virtual provider')}: remote tables or SQL views.`,
        s.n('MPRO') && `${plural(s.n('MPRO'), 'MultiProvider')} become union views.`,
        s.n('HCPR') && `${plural(s.n('HCPR'), 'CompositeProvider')} become graphical or SQL views.`,
      ]),
    }),
    semantic: (s) => ({
      component: 'Analytic models + SAP Analytics Cloud',
      detail: join([
        s.n('QUERY') && `${plural(s.n('QUERY'), 'query', 'queries')} become analytic models and SAC stories${s.measures ? `; ${s.measures} calculated/restricted measures exist natively` : ''}.`,
        s.n('VARIABLE') && `${plural(s.n('VARIABLE'), 'variable')} become analytic model variables${s.exitVars ? ` (${s.exitVars} customer exits to re-implement)` : ''}.`,
        s.authVars && `${s.authVars} authorization variable(s): data access controls.`,
        s.n('AFO') && `${plural(s.n('AFO'), 'AfO workbook')}: Analysis for Office connects to the Datasphere models.`,
      ]),
    }),
    planning: (s) => ({
      component: 'SAP Analytics Cloud planning',
      detail: `${plural(s.planning, 'planning object')}: BW-IP is redesigned in SAC planning on Datasphere models, the SAP-supported path.`,
    }),
    orchestration: (s) => ({
      component: 'Task chains',
      detail: `${plural(s.n('RSPC'), 'process chain')} become task chains, or stay in the BW Bridge with the objects they load.`,
    }),
  },

  bigquery: {
    container: (d) => d.key === CROSS
      ? 'A shared landing project with the SAP replication and the raw datasets, read by the domain projects.'
      : `BigQuery datasets ${slug(d.key).toLowerCase()}_raw, ${slug(d.key).toLowerCase()}_stg and ${slug(d.key).toLowerCase()}_mart, in a Dataform repository for the domain.`,
    shared: 'Build the shared dimensions in one dataset and grant the other domains access through authorized views.',
    ingest: (s) => ({
      component: 'BigQuery Connector for SAP / Data Fusion → raw dataset',
      detail: join([
        s.odp && 'SAP extractors through the Cloud Data Fusion SAP ODP plugin or the BigQuery Connector for SAP (SLT); Cortex Framework has ready models for common SAP sources.',
        s.sapi && 'S-API extractors (BW Service API) should be switched to ODP or SLT replication.',
        s.hana && 'SAP HANA tables replicated (no federation to HANA).',
        s.file && 'Flat files land in Cloud Storage and load as native or external tables.',
      ]),
    }),
    integration: (s) => ({
      component: 'Dataform staging models',
      detail: join([
        s.standardAdso && `${plural(s.standardAdso, 'DataStore object')} become incremental tables (MERGE), history in an append table.`,
        s.n('TRFN') && `${plural(s.n('TRFN'), 'transformation')} become SQL models${s.routines ? `; the ${s.routines} with ABAP routines (${s.abapLines} lines) become SQL, or Python on Cloud Run or Dataproc` : ''}.`,
      ]),
    }),
    masterdata: (s) => ({
      component: 'Dimension tables (Dataform)',
      detail: join([
        `${plural(s.n('IOBJ'), 'master data InfoObject')} become dimension tables with their texts.`,
        s.timeDep && `${s.timeDep} time-dependent: validity columns (SCD type 2).`,
        s.hierarchies && `${s.hierarchies} with hierarchies: flattened level columns, or parent-child for Looker.`,
      ]),
    }),
    marts: (s) => ({
      component: 'Mart dataset (facts and views)',
      detail: join([
        s.realCubes && `${plural(s.realCubes, 'InfoCube')} become partitioned fact tables.`,
        s.virtual && `${plural(s.virtual, 'virtual provider')}: the source must be replicated first.`,
        s.n('MPRO') && `${plural(s.n('MPRO'), 'MultiProvider')} become UNION ALL views.`,
        s.n('HCPR') && `${plural(s.n('HCPR'), 'CompositeProvider')} become views.`,
      ]),
    }),
    semantic: (s) => ({
      component: 'Looker (LookML) and Connected Sheets',
      detail: join([
        s.n('QUERY') && `${plural(s.n('QUERY'), 'query', 'queries')} become Looker explores${s.measures ? `; ${s.measures} calculated/restricted key figures become LookML measures` : ''}.`,
        s.n('VARIABLE') && `${plural(s.n('VARIABLE'), 'variable')} become filters or parameters${s.exitVars ? ` (${s.exitVars} customer exits to re-implement)` : ''}.`,
        s.authVars && `${s.authVars} authorization variable(s): row-level access policies and Looker access filters.`,
        s.n('AFO') && `${plural(s.n('AFO'), 'AfO workbook')}: Connected Sheets or Looker.`,
      ]),
    }),
    planning: (s) => ({
      component: 'Separate planning tool',
      detail: `${plural(s.planning, 'planning object')}: no planning capability on BigQuery. Feed a planning tool from the mart, or keep BW-IP running.`,
    }),
    orchestration: (s) => ({
      component: 'Cloud Composer (Airflow) or Dataform workflows',
      detail: `${plural(s.n('RSPC'), 'process chain')} become DAGs or workflow schedules; housekeeping steps disappear.`,
    }),
  },
};

/** One domain's architecture on a blueprint. */
function domainArchitecture(d, items, all, bp) {
  const s = stats(items, all);
  const planningIds = items.filter((o) => o.category === 'planning').map((o) => o.id);
  const layers = [];
  for (const L of LAYERS) {
    let objs = items.filter((o) => L.types.includes(o.type));
    if (L.key === 'ingest') objs = s.feeding;
    if (L.key === 'planning') objs = items.filter((o) => planningIds.includes(o.id));
    else objs = objs.filter((o) => L.key === 'ingest' || !planningIds.includes(o.id));
    if (!objs.length) continue;
    const out = bp[L.key](s);
    const types = {};
    for (const o of objs) types[o.type] = (types[o.type] || 0) + 1;
    layers.push({
      key: L.key, label: L.label, component: out.component,
      detail: out.detail || (L.key === 'ingest' ? `${plural(objs.length, 'source system')} to connect.` : ''),
      types: Object.entries(types).map(([type, count]) => ({ type, count })),
      ids: objs.map((o) => o.id),
    });
  }
  const notes = [];
  if (s.sharedMd) notes.push(`${plural(s.sharedMd, 'master data InfoObject')} of this domain ${s.sharedMd === 1 ? 'is' : 'are'} also used by other domains. ${bp.shared}`);
  if (s.expert) notes.push(`${plural(s.expert, 'transformation')} with an expert routine: plan a manual rewrite and a reconciliation against BW.`);
  if (s.decom) notes.push(`${plural(s.decom, 'object')} never loaded, never run or inactive: confirm and leave out of scope.`);
  if (d.key === UNASSIGNED) notes.unshift('These objects have no InfoArea, provider or data flow that ties them to a domain. Assign them before planning the migration waves.');
  return {
    key: d.key, label: d.label, special: Boolean(d.special),
    count: items.length,
    average: Math.round((items.reduce((n, o) => n + o.difficulty, 0) / items.length) * 10) / 10,
    container: d.key === UNASSIGNED ? 'No container: assign a domain first.' : bp.container(d, s),
    layers, notes,
  };
}

/**
 * Architecture per domain for a target, for the customer scope and the full scope.
 * Returns null for the generic target (no platform to design for) or without domains.
 */
export function buildArchitecture(objects, domains, targetKey) {
  const target = getTarget(targetKey);
  const bp = BLUEPRINTS[target.key];
  if (!bp || !domains) return null;
  const forScope = (includeSap) => {
    const scope = objects.filter((o) => o.difficulty && o.domain && (includeSap || o.origin !== 'sap'));
    const groups = new Map();
    for (const o of scope) {
      if (!groups.has(o.domain)) groups.set(o.domain, []);
      groups.get(o.domain).push(o);
    }
    return [...groups.entries()]
      .map(([key, items]) => domainArchitecture(domains[key] || { key, label: key }, items, objects, bp))
      .sort((a, b) => a.special - b.special || b.count - a.count || a.label.localeCompare(b.label));
  };
  return { target: { key: target.key, label: target.label }, custom: forScope(false), all: forScope(true) };
}
