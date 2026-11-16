// Migration targets. The generic rules in score.mjs give a base difficulty; a target adds
// adjustments on top of it, each with its reason, for what that platform does natively
// (or lacks). Adjustments only use what the audit read, like the base rules.
//
// adjust[TYPE](o) returns [{ text, points }]; points lower (<0) or raise (>0) the score.
// findings[key] replaces the detail of a finding (see buildFindings in collect.mjs).

const routineKinds = (o) => new Set((o.details?.routines || []).map((r) => r.kind));
const hasRoutines = (o) => (o.details?.routines || []).length > 0;
const isVirtual = (o) => /virtual/i.test(o.details?.providerType || '');
const steps = (o) => o.details?.steps || [];
const housekeeping = (o) => steps(o).some((s) => /ODSACTIVAT|ADSOACT|DROPCUBE|DELTA|CHANGERUN|ATTRIB|REPA|DELREQ/.test(s.processType));

const generic = {
  key: 'generic',
  label: 'Generic platform',
  short: 'Generic',
  description: 'Platform-agnostic rules: no target-specific feature is assumed.',
  adjust: {},
  findings: {},
};

const fabric = {
  key: 'fabric',
  label: 'Microsoft Fabric',
  short: 'Fabric',
  description: 'OneLake Lakehouse/Warehouse (Delta tables), Data Factory pipelines and Dataflows, Spark notebooks, Power BI semantic models.',
  adjust: {
    ADSO: (o) => o.details?.adsoType === 'standard'
      ? [{ text: 'Fabric: Delta MERGE in a Lakehouse or Warehouse covers activation; the change log becomes Delta change data feed', points: -0.5 }]
      : [],
    ODSO: () => [{ text: 'Fabric: activation becomes a Delta MERGE, change log via change data feed', points: -0.5 }],
    CUBE: (o) => isVirtual(o) ? [] : [{ text: 'Fabric: flatten to a fact table; Power BI star schema replaces the dimension tables', points: -0.5 }],
    TRFN: (o) => (hasRoutines(o) ? [] : [{ text: 'Fabric: rules become T-SQL views or a Dataflow Gen2 step' }]),
    LSYS: (o) => {
      const t = o.details?.sourceSystemType || '';
      if (/ODP/.test(t)) return [{ text: 'Fabric: Data Factory SAP connectors (ODP via the on-premises data gateway) or SAP mirroring cover extractors and delta', points: -0.5 }];
      if (t === 'LSYS_HANADB') return [{ text: 'Fabric: SAP HANA connector through the on-premises data gateway' }];
      return [];
    },
    RSPC: (o) => housekeeping(o)
      ? [{ text: 'Fabric: Data Factory pipelines replace the chain; activation and change-run steps disappear with Delta', points: -0.5 }]
      : [{ text: 'Fabric: rebuilt as a Data Factory pipeline' }],
    QUERY: (o) => {
      const d = o.details || {};
      const r = [{ text: 'Fabric: becomes a Power BI semantic model and report', points: -0.5 }];
      if ((d.ckf || 0) + (d.rkf || 0)) r.push({ text: 'Fabric: calculated/restricted key figures become DAX measures' });
      if (d.hasHierarchy) r.push({ text: 'Fabric: BW hierarchies become parent-child DAX or flattened levels', points: 0.5 });
      return r;
    },
    VARIABLE: (o) => o.details?.processing_type === 'Authorization'
      ? [{ text: 'Fabric: reproduced with Power BI row-level security', points: -0.5 }]
      : [],
    AFO: () => [{ text: 'Fabric: Analyze in Excel over the Power BI semantic model replaces the workbook', points: -0.5 }],
    ALVL: () => [{ text: 'Fabric: no native planning; needs a third-party planning tool (Power BI write-back visuals or an EPM tool)' }],
  },
  findings: {
    planning: 'Fabric has no integrated planning. Aggregation levels, planning sequences and planning workbooks need a third-party planning tool on top of Power BI, or BW-IP kept running.',
    extraction: 'Data Factory SAP connectors (ODP, SAP Table, SAP BW) through the on-premises data gateway, or SAP mirroring, read the extractors. Delta initialisation must still be redone.',
    authVariables: 'They depend on BW analysis authorizations. Rebuild them as Power BI row-level security roles on the semantic model.',
  },
};

const snowflakeDbt = {
  key: 'snowflake-dbt',
  label: 'Snowflake + dbt',
  short: 'Snowflake + dbt',
  description: 'Snowflake tables and views, dbt models for transformations. No SAP connector, BI tool or orchestrator is included.',
  adjust: {
    ADSO: (o) => o.details?.adsoType === 'standard'
      ? [{ text: 'dbt: an incremental model (merge) covers activation; dbt snapshots or Snowflake streams replace the change log', points: -0.5 }]
      : [],
    ODSO: () => [{ text: 'dbt: incremental model with merge, snapshots for history', points: -0.5 }],
    HCPR: () => [{ text: 'dbt: becomes a view model, join conditions tested with dbt tests' }],
    MPRO: () => [{ text: 'dbt: becomes a UNION ALL view model' }],
    TRFN: (o) => {
      if (!hasRoutines(o)) return [{ text: 'dbt: rules generated as a SQL model with lineage and tests', points: -0.25 }];
      const k = routineKinds(o);
      return k.has('field') && !k.has('expert') && !k.has('start') && !k.has('end')
        ? [{ text: 'dbt: field routines usually port to CASE expressions or macros' }]
        : [];
    },
    LSYS: (o) => {
      const t = o.details?.sourceSystemType || '';
      if (/ODP|LSYS_BW/.test(t)) return [{ text: 'Snowflake: no SAP connector; needs a third-party replication tool (e.g. Fivetran, SNP Glue, Qlik Replicate) for extractors and delta', points: 0.5 }];
      if (t === 'LSYS_HANADB') return [{ text: 'Snowflake: no federation to HANA; the tables must be replicated', points: 1 }];
      if (t === 'LSYS_FILE') return [{ text: 'Snowflake: files load from an external stage (COPY INTO / Snowpipe)' }];
      return [];
    },
    RSPC: (o) => {
      const r = [{ text: 'dbt: model dependencies replace most load steps; scheduling needs dbt Cloud, Airflow or Snowflake tasks' }];
      if (housekeeping(o)) r.push({ text: 'dbt: activation and change-run steps disappear', points: -0.5 });
      return r;
    },
    QUERY: () => [{ text: 'Snowflake + dbt: no BI layer; needs a BI tool plus a semantic layer (dbt Semantic Layer or Snowflake semantic views)', points: 0.5 }],
    VARIABLE: (o) => o.details?.processing_type === 'Authorization'
      ? [{ text: 'Snowflake: row access policies can carry the authorization logic' }]
      : [],
    AFO: () => [{ text: 'Snowflake + dbt: no Excel planning/analysis add-in; rebuild in the chosen BI tool or Excel over ODBC', points: 0.5 }],
    ALVL: () => [{ text: 'Snowflake + dbt: no planning capability; needs a separate planning tool' }],
  },
  findings: {
    planning: 'Snowflake and dbt have no planning capability. Plan for a dedicated planning tool fed from Snowflake, or keep BW-IP running.',
    extraction: 'Snowflake has no SAP connector. SAP extractors (S-API, ODP) need a third-party replication tool (e.g. Fivetran, SNP Glue, Qlik Replicate), plus delta initialisation.',
    customerExit: 'Variable values computed in ABAP (customer exit / BAdI). Re-implement them as parameters in the BI tool, or as dbt models that compute the value.',
    authVariables: 'They depend on BW analysis authorizations. Redesign them as Snowflake row access policies and BI-tool security.',
  },
};

const datasphere = {
  key: 'datasphere',
  label: 'SAP Datasphere',
  short: 'Datasphere',
  description: 'SAP Datasphere with native SAP connectivity (replication flows, ODP), the SAP BW Bridge for ABAP-based BW objects, analytic models and SAP Analytics Cloud.',
  adjust: {
    ADSO: (o) => {
      const r = [];
      if (o.details?.adsoType === 'standard') r.push({ text: 'Datasphere: local table with delta capture, or the aDSO carried over to the BW Bridge', points: -1 });
      if (o.details?.planning) r.push({ text: 'Datasphere: SAC planning models can write back to Datasphere', points: -1 });
      return r;
    },
    ODSO: () => [{ text: 'Datasphere: convertible to an aDSO in the BW Bridge, or a local table with delta capture', points: -1 }],
    CUBE: (o) => isVirtual(o)
      ? [{ text: 'Datasphere: a remote table or SQL view may replace the virtual provider' }]
      : [{ text: 'Datasphere: becomes a fact view in an analytic model (BW Bridge conversion is possible)', points: -0.5 }],
    MPRO: () => [{ text: 'Datasphere: union view, or a CompositeProvider in the BW Bridge' }],
    HCPR: () => [{ text: 'Datasphere: graphical or SQL view with the same joins and associations', points: -0.5 }],
    TRFN: (o) => {
      if (!hasRoutines(o)) return [{ text: 'Datasphere: transformation flow or graphical view' }];
      return [{ text: 'Datasphere: ABAP routines can be carried over in the SAP BW Bridge; outside the bridge they become SQLScript or Python', points: -1 }];
    },
    LSYS: (o) => {
      const t = o.details?.sourceSystemType || '';
      if (/ODP/.test(t)) return [{ text: 'Datasphere: native ODP connectivity through replication flows (SAP ABAP connection)', points: -1.5 }];
      if (t === 'LSYS_BW') return [{ text: 'Datasphere: S-API extractors carried over through the BW Bridge, or switched to ODP replication flows', points: -1 }];
      if (t === 'LSYS_HANADB') return [{ text: 'Datasphere: SAP HANA connection with remote tables', points: -0.5 }];
      return [];
    },
    RSPC: () => [{ text: 'Datasphere: task chains, or the process chain kept in the BW Bridge', points: -0.5 }],
    QUERY: (o) => {
      const d = o.details || {};
      const r = [{ text: 'Datasphere: analytic model consumed in SAP Analytics Cloud', points: -0.5 }];
      if ((d.ckf || 0) + (d.rkf || 0)) r.push({ text: 'Datasphere: calculated and restricted measures exist in the analytic model' });
      return r;
    },
    VARIABLE: (o) => {
      const p = o.details?.processing_type;
      if (p === 'UserEntry' || p === 'ReplacementPath') return [{ text: 'Datasphere: analytic model variables' }];
      if (p === 'Authorization') return [{ text: 'Datasphere: data access controls replace analysis authorizations', points: -0.5 }];
      if (p === 'SAPExit') return [{ text: 'Datasphere: dynamic date variables cover the common SAP exits', points: -0.5 }];
      return [];
    },
    AFO: () => [{ text: 'Datasphere: Analysis for Office connects to SAP Analytics Cloud and Datasphere models', points: -1 }],
    ALVL: () => [{ text: 'Datasphere: BW-IP moves to SAC planning on Datasphere; still a redesign, but an SAP-supported path', points: -1 }],
  },
  findings: {
    planning: 'BW-IP has no direct equivalent in Datasphere. The SAP-supported path is SAP Analytics Cloud planning on Datasphere models: aggregation levels, planning functions and sequences are redesigned there.',
    extraction: 'Datasphere reads SAP extractors natively: ODP through replication flows, and S-API extractors through the SAP BW Bridge. Delta initialisation must still be redone.',
    expert: 'The whole transformation is ABAP. It can run unchanged in the SAP BW Bridge; moving it into core Datasphere means a manual rewrite in SQLScript or Python.',
    startEnd: 'Package-level ABAP that filters, enriches or aggregates data. It runs in the SAP BW Bridge as is; in core Datasphere its intent has to be reverse-engineered and rebuilt.',
    classic: 'InfoCubes, classic DSOs and MultiProviders can be converted to aDSOs and CompositeProviders in the SAP BW Bridge, or remodeled as Datasphere tables and views.',
    authVariables: 'They depend on BW analysis authorizations. Rebuild them as Datasphere data access controls.',
  },
};

const bigquery = {
  key: 'bigquery',
  label: 'Google BigQuery',
  short: 'BigQuery',
  description: 'BigQuery tables and views, Dataform or SQL for transformations, Cloud Composer for orchestration, Looker for reporting, the BigQuery Connector for SAP and Cortex Framework.',
  adjust: {
    ADSO: (o) => o.details?.adsoType === 'standard'
      ? [{ text: 'BigQuery: MERGE statements or Dataform incremental tables cover activation; change history kept in a separate table', points: -0.5 }]
      : [],
    ODSO: () => [{ text: 'BigQuery: activation becomes a MERGE, change log as an append table', points: -0.5 }],
    TRFN: (o) => (hasRoutines(o) ? [] : [{ text: 'BigQuery: rules become SQL (Dataform) models' }]),
    LSYS: (o) => {
      const t = o.details?.sourceSystemType || '';
      if (/ODP/.test(t)) return [{ text: 'BigQuery: Cloud Data Fusion SAP ODP plugin or the BigQuery Connector for SAP (SLT) read extractors; Cortex Framework provides ready models', points: -0.5 }];
      if (t === 'LSYS_HANADB') return [{ text: 'BigQuery: no federation to HANA; tables replicated with the BigQuery Connector for SAP or Data Fusion', points: 0.5 }];
      if (t === 'LSYS_FILE') return [{ text: 'BigQuery: files land in Cloud Storage and load as external or native tables' }];
      return [];
    },
    RSPC: (o) => housekeeping(o)
      ? [{ text: 'BigQuery: Cloud Composer (Airflow) or Dataform workflows replace the chain; housekeeping steps disappear', points: -0.25 }]
      : [{ text: 'BigQuery: rebuilt in Cloud Composer (Airflow) or Dataform workflows' }],
    QUERY: (o) => {
      const d = o.details || {};
      const r = [{ text: 'BigQuery: becomes a Looker explore (LookML) or a Looker Studio report' }];
      if ((d.ckf || 0) + (d.rkf || 0)) r.push({ text: 'BigQuery: calculated/restricted key figures become LookML measures' });
      return r;
    },
    VARIABLE: (o) => o.details?.processing_type === 'Authorization'
      ? [{ text: 'BigQuery: row-level access policies and Looker access filters carry the logic' }]
      : [],
    AFO: () => [{ text: 'BigQuery: Connected Sheets or Looker replace the Excel workbook', points: 0.5 }],
    ALVL: () => [{ text: 'BigQuery: no planning capability; needs a separate planning tool' }],
  },
  findings: {
    planning: 'BigQuery has no planning capability. Plan for a dedicated planning tool fed from BigQuery, or keep BW-IP running.',
    extraction: 'SAP extractors need the Cloud Data Fusion SAP ODP plugin, the BigQuery Connector for SAP (SLT) or a third-party tool, plus delta initialisation. Cortex Framework provides ready-made models for common SAP sources.',
    authVariables: 'They depend on BW analysis authorizations. Redesign them as BigQuery row-level access policies and Looker access filters.',
  },
};

export const TARGETS = Object.fromEntries([generic, fabric, snowflakeDbt, datasphere, bigquery].map((t) => [t.key, t]));
export const DEFAULT_TARGET = 'generic';

export function getTarget(key) {
  return TARGETS[key] || TARGETS[DEFAULT_TARGET];
}

/** Public description of the targets, for the page and the chat. */
export function targetList() {
  return Object.values(TARGETS).map(({ key, label, short, description }) => ({ key, label, short, description }));
}
