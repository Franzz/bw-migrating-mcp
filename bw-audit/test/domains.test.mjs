// Domains (top-level InfoAreas), master data placement and the target architecture.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../lib/parse.mjs';
import { assignDomains, CROSS, UNASSIGNED } from '../lib/domains.mjs';
import { buildArchitecture } from '../lib/architecture.mjs';
import { scoreObject, summarize } from '../lib/score.mjs';

test('provider characteristics: namespaces restored, navigation attributes folded', () => {
  const text = `InfoCube: /ERP/FC_IC04
InfoArea:    /ERP/FCLM

── Characteristics (4) ──
  INFOOBJECT   KIND                 TYPE      TEXT
  $ERP$ACC_ID  characteristic       NUMC 10   Bank Account
  0CALDAY      time characteristic            Calendar Day
  $ERP$ACC_ID__/ERP/ACCDES
  ZCOSTC       characteristic       CHAR 10   Cost center

── Key Figures (1) ──
  INFOOBJECT   KIND                 TYPE      TEXT
  $ERP$PLAMT   key figure           CURR      Plan Cash In Amount
`;
  assert.deepEqual(P.providerInfoObjects(text), ['/ERP/ACC_ID', '0CALDAY', 'ZCOSTC']);
  assert.equal(P.parseProvider(text).infoArea, '/ERP/FCLM');
  assert.deepEqual(P.adsoInfoObjects('<element xsi:type="adso:AdsoElement" name="F1" infoObjectName="ZCOSTC"/><element name="F2"/>'), ['ZCOSTC']);
  assert.deepEqual(P.parseAggregationLevel('Aggregation Level: AL1\nInfoArea:          /ERP/FCLM\nInfoProvider:      $ERP$FC_IC04\n'), { infoArea: '/ERP/FCLM', provider: '/ERP/FC_IC04' });
});

const AREAS = [
  { name: 'FIN', label: 'Finance', parent: null },
  { name: 'FIN_AP', label: 'Payables', parent: 'FIN' },
  { name: 'SALES', label: 'Sales', parent: null },
];

function system() {
  const o = (type, name, details = {}, extra = {}) => ({ id: `${type}:${name}`, type, name, origin: 'custom', flags: [], details, ...extra });
  return [
    o('ADSO', 'AP_ITEMS', { infoArea: 'FIN_AP', infoObjects: ['ZCOSTC', 'ZVENDOR'] }),
    o('CUBE', 'FIN_C01', { infoArea: 'FIN', infoObjects: ['ZCOSTC'] }),
    o('HCPR', 'SD_CP01', { infoArea: 'SALES', infoObjects: ['ZCOSTC', 'ZCUST'] }),
    o('IOBJ', 'ZCOSTC', { infoArea: 'SALES', masterData: true }),
    o('TRFN', 'T1', { flow: { source: { type: 'RSDS', name: 'DS_COSTC', sourceSystem: 'FILE' }, target: { type: 'IOBJ', name: 'ZCOSTC' } } }),
    o('DTPA', 'D1', { flow: { source: { type: 'RSDS', name: 'DS_COSTC', sourceSystem: 'FILE' }, target: { type: 'IOBJ', name: 'ZCOST' } } }),
    o('TRFN', 'T2', { flow: { source: { type: 'RSDS', name: 'DS_SD', sourceSystem: 'ECC' }, target: { type: 'TRCS', name: 'SD_IS' } } }),
    o('TRFN', 'T3', { flow: { source: { type: 'TRCS', name: 'SD_IS', sourceSystem: null }, target: { type: 'HCPR', name: 'SD_CP01' } } }),
    o('QUERY', 'Q1', { provider: 'SD_CP01' }),
    o('VARIABLE', 'V1', { info_object: 'ZCOSTC', processing_type: 'UserEntry' }),
    o('RSPC', 'PC1', { steps: [{ processType: 'DTP_LOAD', variant: 'D1' }] }),
    o('LSYS', 'FILE', { sourceSystemType: 'LSYS_FILE' }),
    o('LSYS', 'ECC', { sourceSystemType: 'LSYS_ODP_SAP' }),
    o('LSYS', 'IDLE', { sourceSystemType: 'LSYS_FILE' }),
    o('AFO', 'WB1', { queries: ['Q1'] }),
  ];
}

test('domains: root InfoAreas, master data by use, flows follow their target', () => {
  const objects = system();
  const { domains } = assignDomains(objects, AREAS);
  const d = Object.fromEntries(objects.map((o) => [o.name, o.domain]));
  assert.equal(d.AP_ITEMS, 'FIN', 'sub-area rolls up to its top-level InfoArea');
  // ZCOSTC: 2 providers in FIN, 1 in SALES (its own InfoArea): most used wins.
  assert.equal(d.ZCOSTC, 'FIN');
  assert.match(objects.find((o) => o.name === 'ZCOSTC').domainVia, /2 of 3/);
  assert.equal(d.T1, 'FIN', 'the flow loading master data goes with it');
  assert.equal(d.D1, 'FIN', 'a truncated target name still resolves');
  assert.equal(d.PC1, 'FIN');
  assert.equal(d.V1, 'FIN');
  assert.equal(d.T2, 'SALES', 'InfoSource resolved forward to its provider');
  assert.equal(d.Q1, 'SALES');
  assert.equal(d.WB1, 'SALES');
  assert.equal(d.FILE, 'FIN');
  assert.equal(d.ECC, 'SALES');
  assert.equal(d.IDLE, UNASSIGNED);
  assert.deepEqual(domains.FIN.areas.sort(), ['FIN', 'FIN_AP']);
  assert.equal(domains[CROSS].special, true);
});

test('domains: a source system feeding several domains is cross-domain', () => {
  const objects = system();
  objects.find((o) => o.name === 'T2').details.flow.source.sourceSystem = 'FILE';
  assignDomains(objects, AREAS);
  assert.equal(objects.find((o) => o.name === 'FILE').domain, CROSS);
});

test('master data used in several domains scores higher, summary groups by domain', () => {
  const objects = system();
  const { domains } = assignDomains(objects, AREAS);
  const usage = objects.find((o) => o.name === 'ZCOSTC').details.usage;
  assert.deepEqual(usage, { FIN: 2, SALES: 1 });
  const scored = objects.map((o) => scoreObject(o));
  const md = scored.find((o) => o.name === 'ZCOSTC');
  assert.equal(md.category, 'masterdata');
  assert.ok(md.reasons.some((r) => /2 domains/.test(r)));
  const byDomain = summarize(scored, { domains }).byDomain;
  assert.deepEqual(byDomain.map((x) => x.key), ['FIN', 'SALES', UNASSIGNED]);
  assert.equal(byDomain.find((x) => x.key === 'FIN').label, 'Finance');
});

test('architecture: none for the generic target, layers per domain otherwise', () => {
  const objects = system();
  const { domains } = assignDomains(objects, AREAS);
  const scored = objects.map((o) => scoreObject(o, 'fabric'));
  assert.equal(buildArchitecture(scored, domains, 'generic'), null);
  assert.equal(buildArchitecture(scored, domains, undefined), null);
  const arch = buildArchitecture(scored, domains, 'fabric');
  assert.equal(arch.target.key, 'fabric');
  const fin = arch.custom.find((d) => d.key === 'FIN');
  assert.match(fin.container, /workspace FIN/);
  const layers = Object.fromEntries(fin.layers.map((l) => [l.key, l]));
  assert.ok(layers.masterdata.ids.includes('IOBJ:ZCOSTC'));
  assert.ok(layers.ingest.ids.includes('LSYS:FILE'));
  assert.ok(layers.integration.ids.includes('TRFN:T1'));
  assert.ok(fin.notes.some((n) => /also used by other domains/.test(n)));
  for (const t of ['snowflake-dbt', 'datasphere', 'bigquery']) {
    const a = buildArchitecture(objects.map((o) => scoreObject(o, t)), domains, t);
    assert.ok(a.custom.every((d) => d.container && d.layers.every((l) => l.component)), t);
  }
});
