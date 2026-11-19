// Parsers and scoring rules, on output captured from the bw-mcp server.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../lib/parse.mjs';
import { scoreObject, summarize } from '../lib/score.mjs';

const TRFN = `Transformation: 09YGFH7SIX650LN8WOHEQZWNT72H1TLF
Source: metadata tables (read-only — this system publishes no REST resource for TRFN)
Status: active
Source: ADSO WFIGL001
Target: ADSO DFIGL001

── Routines ──
  globalPart: (none)
  startRoutine: (none)
  endRoutine: (none)
  expertRoutine: (none)
  NORMAL (rule 5, step 1, code id 0MAXO6VVTOEOCAAKW0A8J1TS0):
          ... "insert your code here
      *    raise exception type CX_RSROUT_ABORT.
          CASE &SF&-fiscvarnt.
            WHEN 'K2'.
              &RS& = &SF&-/b631/s_amount * 14 / 12.
            WHEN OTHERS.
              &RS& = &SF&-/b631/s_amount.
          ENDCASE.

── Field Mappings ──
  [TIME]  0FISCVARNT  →  0FISCVARNT
  [DIRECT]  $ERP$GL_ACCT  →  $ERP$GL_ACCT
  [ROUTINE]  0FISCVARNT, $ERP$AMOUNT, 0CURRENCY  →  0CURRENCY, $ERP$AMOUNT  {AGGREGATION: SUM}
  [CONSTANT = ""]  (none)  →  0RECORDMODE
`;

test('transformation: field routine, effective ABAP lines, endpoints', () => {
  const t = P.parseTransformation(TRFN);
  assert.equal(t.status, 'active');
  assert.deepEqual(t.source, { type: 'ADSO', name: 'WFIGL001', extra: null });
  assert.equal(t.target.name, 'DFIGL001');
  assert.equal(t.routines.length, 1);
  assert.equal(t.routines[0].kind, 'field');
  assert.equal(t.abapLines, 6);
  assert.deepEqual(t.ruleTypes, { TIME: 1, DIRECT: 1, ROUTINE: 1, CONSTANT: 1 });
  const scored = scoreObject({ type: 'TRFN', name: 'X', origin: 'custom', flags: [], details: t });
  assert.equal(scored.difficulty, 2);
  assert.equal(scored.category, 'logic');
});

test('expert routine scores as redesign', () => {
  const s = scoreObject({ type: 'TRFN', name: 'X', flags: [], details: { routines: [{ kind: 'expert', lines: 300, patterns: [] }], abapLines: 300, patterns: [], ruleTypes: {} } });
  assert.equal(s.difficulty, 5);
});

test('search results with path subtype', () => {
  const items = P.parseSearch(`BW Search: "*" (type: ELEM)

Found 2 result(s):

1. /EFI/SIGNFLIPPING (ELEM) — active — "SignFlipping"
   Path: /sap/bw/modeling/variable/%24efi%24signflipping/a
2. ADSOTAR (ADSO) — active
   Path: /sap/bw/modeling/adso/adsotar/m`);
  assert.equal(items.length, 2);
  assert.equal(items[0].subtype, 'variable');
  assert.equal(items[1].description, '');
});

test('process chain last status', () => {
  const s = P.parseChainStatus(`Process Chain Last Status: *

── Last run per chain (2) ──
  STATUS                          START                 CHAIN
  -  never run                                        0TCTHC_CHECK_REP_DATA
  !R  red    ended with errors    2026-06-26 05:57:48  U02_PC_DAO

A "!" marks a run that ended red.`);
  assert.deepEqual(s.map((c) => [c.chain, c.color]), [['0TCTHC_CHECK_REP_DATA', 'none'], ['U02_PC_DAO', 'red']]);
  assert.equal(s[1].statusText, 'ended with errors');
});

test('provider with parts and empty load history', () => {
  const p = P.parseProvider(`MultiProvider: /ERP/SFIN_M01
Type:        MultiProvider

── Part Providers (2) ──
    1  CUBE  /ERP/SFIN_R01
    2  CUBE  /ERP/SFIN_V01

── Load History ──
  no requests (never loaded, or the history has been deleted)`);
  assert.deepEqual(p.parts.map((x) => x.name), ['/ERP/SFIN_R01', '/ERP/SFIN_V01']);
  assert.equal(p.requests, 0);
});

test('namespaces', () => {
  assert.equal(P.isSapName('0TCT_C01'), true);
  assert.equal(P.isSapName('/ERP/SFIN_V01'), true);
  assert.equal(P.isSapName('/BIC/ZSALES'), false);
  assert.equal(P.isSapName('ZSON'), false);
});

test('summary excludes SAP content unless asked', () => {
  const objs = [
    { type: 'LSYS', origin: 'custom', flags: [], details: { sourceSystemType: 'LSYS_FILE' } },
    { type: 'ALVL', origin: 'sap', flags: [], details: {} },
  ].map(scoreObject);
  assert.equal(summarize(objs).objects, 1);
  assert.equal(summarize(objs, { includeSap: true }).objects, 2);
});

test('targets adjust the generic score and keep their reasons', async () => {
  const { TARGETS } = await import('../lib/targets.mjs');
  const lsys = { type: 'LSYS', name: 'ECC', flags: [], details: { sourceSystemType: 'LSYS_ODP_SAP' } };
  const generic = scoreObject(lsys);
  assert.equal(generic.difficulty, 3);
  assert.equal(scoreObject(lsys, 'generic').difficulty, 3);
  const ds = scoreObject(lsys, 'datasphere');
  assert.ok(ds.difficulty < generic.difficulty);
  assert.ok(ds.reasons.some((r) => r.startsWith('Datasphere:')));
  assert.ok(scoreObject(lsys, 'snowflake-dbt').difficulty >= generic.difficulty);
  assert.equal(scoreObject(lsys, 'unknown').difficulty, 3);
  assert.deepEqual(Object.keys(TARGETS), ['generic', 'fabric', 'snowflake-dbt', 'datasphere', 'bigquery']);
});

// ---------- 3.x data flow, output captured from a 7.5 system ----------

const UPDR_LIST = `Update rules (3.x) matching *: 3 (active 1, modified 0, delivered 2)

  ZZUPD000000000000000000A1  ZSALES01 <- ZIS_SALES  [active, routines 2, start routine, changed 2019-03-01 10:00:00 by DEV]
  3X7AY5D1RPF0HJBDMYZS6RZSW  0BPM_C01 <- 80BPM_DS01  [delivered content (not installed), routines 2, changed 2005-08-29 11:38:48 by SAP]
  1KP4BYTGE4WRXGIQZMKOIW4H5  0BCTCBC01 <- 0BCT_CB_1  [delivered content (not installed), routines 0, changed 2004-09-08 15:04:25 by SAP]

Read one with object_type="UPDR" and its id (the first column).`;

const ISFS_LIST = `3.x DataSources matching *: 3 (active 2, modified 0, delivered 1)

  80TCTHP24O  S4HCLNT100 — Real Time Daemon Statistics  [active, transaction data, export DataSource (generated), delta ODS, feeds 80TCTHP24O]
  ZDS_FILE  PC_FILE  [active, transaction data, feeds ZIS_SALES, migrated to RSDS]
  2LIS_11_VAHDR  S4HCLNT100 — Sales Document Header  [delivered content (not installed), transaction data]

Export DataSources (names starting with 8) are generated by BW for data mart loads`;

const UPDR_READ = `Update Rules: ZZUPD000000000000000000A1
Source: metadata tables (3.x data flow — no release publishes a REST resource for it)
Target:       ZSALES01
InfoSource:   ZIS_SALES — Sales
Version:      A — active
Expert mode:  no
Program:      GP000
Last changed: 2019-03-01 10:00:00 by DEV

── Key Figure Rules (2) ──
  [SOURCE_INFOOBJECT] ZAMOUNT <- ZAMOUNT   (addition, source InfoObject, characteristics: set 1)
  [ROUTINE] ZQTY <- routine 0002   (addition, routine, characteristics: set 1)

── Characteristic Rules (1 set) ──
  set 1 — used by rules 0001, 0002:
    [SOURCE_INFOOBJECT] 0CUSTOMER <- 0CUSTOMER
    [MASTER_DATA_READ] 0COUNTRY <- master data of 0CUSTOMER (attribute 0COUNTRY)

── Routines ──
  globalPart: (none)
  startRoutine: (code id AAA)
      DELETE DATA_PACKAGE WHERE amount = 0.
      SELECT * FROM /bic/azsales00 INTO TABLE gt_old.
  routine 0002 (ZQTY, code id BBB):
      RESULT = COMM_STRUCTURE-qty * 2.
`;

test('3.x listings keep the version of every object', () => {
  const u = P.parseUpdateRuleList(UPDR_LIST);
  assert.equal(u.length, 3);
  assert.deepEqual(u.filter((x) => x.active).map((x) => [x.id, x.target, x.infoSource, x.routines, x.startRoutine]),
    [['ZZUPD000000000000000000A1', 'ZSALES01', 'ZIS_SALES', 2, true]]);
  const d = P.parseDataSource3xList(ISFS_LIST);
  assert.deepEqual(d.map((x) => [x.name, x.active, x.export, x.migrated]), [
    ['80TCTHP24O', true, true, false], ['ZDS_FILE', true, false, true], ['2LIS_11_VAHDR', false, false, false],
  ]);
  assert.equal(d[0].description, 'Real Time Daemon Statistics');
});

test('update rules are read and scored like a transformation, plus the cost of leaving 3.x', () => {
  const details = P.parseFlow3x(UPDR_READ);
  assert.equal(details.version, 'A');
  assert.equal(details.target, 'ZSALES01');
  assert.equal(details.infoSource, 'ZIS_SALES');
  assert.deepEqual(details.routines.map((r) => r.kind), ['start', 'field']);
  assert.ok(details.patterns.some((p) => p.key === 'db_select'));
  assert.equal(details.ruleTypes.MASTER_DATA_READ, 1);
  const o = scoreObject({ type: 'UPDR', name: 'ZZUPD000000000000000000A1', details }, 'generic');
  assert.equal(o.category, 'logic');
  assert.match(o.reasons[0], /3\.x data flow/);
  assert.ok(o.reasons.some((r) => /Start routine/.test(r)));
  assert.ok(o.difficulty >= 4);
});

test('the classic release finding states what of the 3.x data flow actually runs', async () => {
  const { summarize3x, describe3x } = await import('../lib/collect.mjs');
  const summary = summarize3x({
    updateRules: P.parseUpdateRuleList(UPDR_LIST), transferRules: null,
    dataSources: P.parseDataSource3xList(ISFS_LIST), infoSources: [],
  });
  const text = describe3x(summary);
  assert.match(text, /1 active update rule, 2 active 3\.x DataSources \(1 of them export DataSources/);
  assert.match(text, /Another 3 3\.x objects exist only as Business Content delivery copies/);
  assert.match(text, /Not readable: transfer rules\./);
  assert.match(describe3x(null), /were not checked/);
});

test('the system profile gives the installed release, not the modeling backend number', () => {
  const s = P.parseSystemProfile(`── System ──
Platform:        classic SAP BW (7.5 or lower)  [bw.b4hanamode = STANDARD]
Software:        SAP_BW 758 SP02, SAP_BASIS 758 SP02 — embedded in SAP S/4HANA (S4CORE 108 SP02)
Verdict from:    systeminfo
Logical system:  S4HCLNT100
Server version:  73001/0015
Database:        HDB`);
  assert.equal(s.platform, 'classic SAP BW (not BW/4HANA)');
  assert.equal(s.classic, true);
  assert.equal(s.software, 'SAP_BW 758 SP02, SAP_BASIS 758 SP02 — embedded in SAP S/4HANA (S4CORE 108 SP02)');
  assert.equal(s.backendVersion, '73001/0015');
  assert.equal(P.parseSystemProfile('Software:        ? (CVERS not readable: HTTP 403)').software, null);
});
