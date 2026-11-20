import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLineage, layoutLineage } from '../public/lineage.js';

const object = (type, name, details = {}, extra = {}) => ({ id: `${type}:${name}`, type, name, details, domain: 'SALES', origin: 'custom', ...extra });
const flow = (source, target) => ({ flow: { source, target } });

test('DataSource → transformation → aDSO → CompositeProvider → BW query flows upward', () => {
  const objects = [
    object('TRFN', 'LOAD', flow({ type: 'RSDS', name: 'ORDERS', sourceSystem: 'ERP' }, { type: 'ADSO', name: 'ORDERS_RAW' })),
    object('ADSO', 'ORDERS_RAW'),
    object('HCPR', 'SALES_VIEW', { inputProviders: ['ADSO ORDERS_RAW'] }),
    object('QUERY', 'SALES_QUERY', { provider: 'SALES_VIEW' }),
  ];
  const graph = layoutLineage(buildLineage(objects, { domain: 'SALES' }));
  assert.equal(graph.nodes.length, 5);
  assert.equal(graph.edges.length, 4);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  for (const e of graph.edges) {
    assert.ok(byId.get(e.from).y > byId.get(e.to).y);
    assert.equal(e.feedback, false);
  }
  const source = graph.nodes.find((n) => n.type === 'RSDS');
  assert.equal(source.sourceSystem, 'ERP');
  assert.equal(source.inspectable, false);
});

test('domain selection retains upstream references and excludes unrelated domains', () => {
  const objects = [object('ADSO', 'SHARED', {}, { domain: 'SHARED', origin: 'sap' }),
    object('MPRO', 'SALES_VIEW', { parts: [{ type: 'ADSO', name: 'SHARED' }] }),
    object('QUERY', 'QUERY', { provider: 'SALES_VIEW' }), object('ADSO', 'UNRELATED', {}, { domain: 'OTHER' })];
  const graph = buildLineage(objects, { domain: 'SALES' });
  assert.equal(graph.nodes.length, 3);
  const shared = graph.nodes.find((n) => n.name === 'SHARED');
  assert.equal(shared.context, true);
  assert.equal(shared.inspectable, false);
  assert.equal(buildLineage(objects, { domain: 'SHARED' }).nodes.length, 0);
  assert.equal(buildLineage(objects, { domain: 'SHARED', includeSap: true }).nodes.length, 1);
});

test('missing query/provider metadata stays unlinked; unique truncated endpoints resolve', () => {
  const objects = [object('QUERY', 'UNKNOWN'), object('ADSO', 'TARGET_LONG'),
    object('TRFN', 'LOAD', flow({ type: 'RSDS', name: 'SOURCE' }, { type: 'ADSO', name: 'TARGET_LO' }))];
  const graph = buildLineage(objects, { domain: 'SALES' });
  assert.equal(graph.edges.length, 2);
  assert.ok(graph.edges.some((e) => e.to === 'ADSO:TARGET_LONG'));
  assert.ok(!graph.edges.some((e) => e.to === 'QUERY:UNKNOWN'));
});

test('DataSources with the same name in different source systems remain distinct', () => {
  const objects = ['ERP1', 'ERP2'].map((sourceSystem) => object('TRFN', sourceSystem,
    flow({ type: 'RSDS', name: 'ORDERS', sourceSystem }, { type: 'ADSO', name: 'TARGET' })));
  objects.push(object('ADSO', 'TARGET'));
  const graph = buildLineage(objects, { domain: 'SALES' });
  assert.equal(graph.nodes.filter((n) => n.type === 'RSDS').length, 2);
});

test('self-loading aDSOs preserve the cycle without blocking layout', () => {
  const endpoint = { type: 'ADSO', name: 'TARGET' };
  const graph = layoutLineage(buildLineage([object('ADSO', 'TARGET'), object('TRFN', 'RELOAD', flow(endpoint, endpoint))]));
  assert.equal(graph.edges.length, 2);
  assert.equal(graph.edges.filter((e) => e.feedback).length, 1);
  for (const n of graph.nodes) assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y));
  assert.deepEqual(layoutLineage({ nodes: [], edges: [] }), { nodes: [], edges: [], width: 0, height: 0 });
});

test('older snapshots can supply transformation links from the flows list', () => {
  const graph = buildLineage([object('TRFN', 'LOAD'), object('ADSO', 'TARGET')], {
    flows: [{ transformation: 'LOAD', source: { type: 'RSDS', name: 'SOURCE' }, target: { type: 'ADSO', name: 'TARGET' } }],
  });
  assert.equal(graph.edges.length, 2);
});
