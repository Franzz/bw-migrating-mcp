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
