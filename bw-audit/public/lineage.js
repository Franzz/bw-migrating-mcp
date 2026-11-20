const PROVIDERS = new Set(['ADSO', 'ODSO', 'CUBE', 'MPRO', 'HCPR', 'ALVL']);
const LOADS = new Set(['TRFN', 'UPDR', 'ISTS']);
const SOURCES = new Set(['RSDS', 'ISFS']);
const VISIBLE = new Set([...PROVIDERS, ...LOADS, ...SOURCES, 'QUERY', 'IOBJ', 'TRCS', 'ISTD']);

/** Build recorded dependencies, keeping upstream references across domain/scope boundaries. */
export function buildLineage(objects, { domain, includeSap = false, flows = [] } = {}) {
  const nodes = new Map();
  const edges = new Map();
  const named = new Map();
  for (const o of objects) {
    if (!VISIBLE.has(o.type)) continue;
    const node = { ...o, objectId: o.id, sourceSystem: o.details?.sourceSystem || null };
    nodes.set(o.id, node);
    const hits = named.get(o.name) || [];
    hits.push(node);
    named.set(o.name, hits);
  }
  const endpoint = (ep) => {
    if (!ep?.name) return null;
    const matches = (n) => (ep.type === 'PROV' ? PROVIDERS.has(n.type) : n.type === ep.type)
      && (!SOURCES.has(n.type) || !ep.sourceSystem || n.sourceSystem === ep.sourceSystem);
    let hits = (named.get(ep.name) || []).filter(matches);
    if (!hits.length && !SOURCES.has(ep.type)) {
      hits = [...named.entries()].filter(([name]) => name.startsWith(ep.name)).flatMap(([, list]) => list.filter(matches));
    }
    if (hits.length === 1) return hits[0].id;
    const id = `ref:${ep.type}:${ep.name}${ep.sourceSystem ? `@${ep.sourceSystem}` : ''}`;
    if (!nodes.has(id)) nodes.set(id, { id, type: ep.type, name: ep.name, sourceSystem: ep.sourceSystem, description: '', objectId: null });
    return id;
  };
  const connect = (from, to) => {
    if (from && to) edges.set(JSON.stringify([from, to]), { from, to });
  };
  const providerEndpoint = (name) => {
    if (!name) return null;
    const known = (named.get(name) || []).filter((n) => PROVIDERS.has(n.type));
    return known.length === 1 ? known[0].id : endpoint({ type: 'PROV', name });
  };
  const flowByName = new Map(flows.map((f) => [f.transformation, f]));
  for (const o of objects) {
    if (!nodes.has(o.id)) continue;
    const d = o.details || {};
    if (LOADS.has(o.type)) {
      const flow = d.flow || flowByName.get(o.name);
      if (flow) {
        connect(endpoint(flow.source), o.id);
        connect(o.id, endpoint(flow.target));
      }
    }
    if (o.type === 'QUERY' || o.type === 'ALVL') connect(providerEndpoint(d.provider), o.id);
    if (o.type === 'MPRO') for (const part of d.parts || []) connect(endpoint(part), o.id);
    if (o.type === 'HCPR') for (const input of d.inputProviders || []) {
      const match = input.match(/^(\S+)\s+(.+)$/);
      if (match) connect(endpoint({ type: match[1], name: match[2] }), o.id);
    }
  }
  const incoming = new Map();
  for (const e of edges.values()) {
    const list = incoming.get(e.to) || [];
    list.push(e.from);
    incoming.set(e.to, list);
  }
  const selected = new Set([...nodes.values()].filter((n) => n.objectId
    && (!domain || (n.domain || '~unassigned') === domain) && (includeSap || n.origin !== 'sap')).map((n) => n.id));
  const keep = new Set(selected);
  const queue = [...keep];
  for (let i = 0; i < queue.length; i++) for (const id of incoming.get(queue[i]) || []) {
    if (!keep.has(id)) { keep.add(id); queue.push(id); }
  }
  return {
    nodes: [...keep].map((id) => ({ ...nodes.get(id), context: !selected.has(id),
      inspectable: Boolean(nodes.get(id).objectId && (includeSap || nodes.get(id).origin !== 'sap')) })),
    edges: [...edges.values()].filter((e) => keep.has(e.from) && keep.has(e.to)),
  };
}

/** Layer the graph upward; break cycles for layout while preserving their edges. */
export function layoutLineage(graph) {
  const boxWidth = 216; const boxHeight = 76; const columnGap = 30; const rowGap = 52; const padding = 28;
  if (!graph.nodes.length) return { ...graph, width: 0, height: 0 };
  const nodes = graph.nodes.map((n) => ({ ...n, rank: SOURCES.has(n.type) ? 0 : 1 }));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const incoming = new Map(nodes.map((n) => [n.id, []]));
  const outgoing = new Map(nodes.map((n) => [n.id, []]));
  for (const e of graph.edges) { incoming.get(e.to).push(e.from); outgoing.get(e.from).push(e.to); }
  const pending = new Set(nodes.map((n) => n.id));
  const degrees = new Map(nodes.map((n) => [n.id, incoming.get(n.id).length]));
  const ready = nodes.filter((n) => !degrees.get(n.id)).map((n) => n.id);
  let index = 0;
  while (pending.size) {
    if (index === ready.length) ready.push(pending.values().next().value);
    const id = ready[index++];
    if (!pending.delete(id)) continue;
    const node = byId.get(id);
    for (const target of outgoing.get(id)) {
      if (!pending.has(target)) continue;
      byId.get(target).rank = Math.max(byId.get(target).rank, node.rank + 1);
      degrees.set(target, degrees.get(target) - 1);
      if (!degrees.get(target)) ready.push(target);
    }
  }
  const queryRank = Math.max(...nodes.filter((n) => n.type !== 'QUERY').map((n) => n.rank), 0) + 1;
  for (const n of nodes) if (n.type === 'QUERY') n.rank = queryRank;
  const ranks = [...new Set(nodes.map((n) => n.rank))].sort((a, b) => b - a);
  const rows = ranks.map((rank) => nodes.filter((n) => n.rank === rank).sort((a, b) => a.name.localeCompare(b.name)));
  const width = Math.max(...rows.map((row) => row.length)) * (boxWidth + columnGap) - columnGap + padding * 2;
  const height = rows.length * (boxHeight + rowGap) - rowGap + padding * 2;
  // Place consumers near their inputs to reduce crossing between adjacent rows.
  for (let r = rows.length - 1; r >= 0; r--) {
    const center = (n) => {
      const inputs = incoming.get(n.id).map((id) => byId.get(id)).filter((p) => p.x != null);
      return inputs.length ? inputs.reduce((s, p) => s + p.x, 0) / inputs.length : width / 2;
    };
    rows[r].sort((a, b) => center(a) - center(b) || a.name.localeCompare(b.name));
    const rowWidth = rows[r].length * (boxWidth + columnGap) - columnGap;
    rows[r].forEach((n, c) => Object.assign(n, { x: (width - rowWidth) / 2 + c * (boxWidth + columnGap), y: padding + r * (boxHeight + rowGap), width: boxWidth, height: boxHeight }));
  }
  const edges = graph.edges.map((e) => {
    const from = byId.get(e.from); const to = byId.get(e.to);
    const x1 = from.x + boxWidth / 2; const y1 = from.y;
    const x2 = to.x + boxWidth / 2; const y2 = to.y + boxHeight;
    const feedback = from.rank >= to.rank;
    const bend = feedback ? Math.max(from.x, to.x) + boxWidth + 18 : null;
    const path = feedback ? `M${x1},${y1} C${bend},${y1 - 24} ${bend},${y2 + 24} ${x2},${y2}`
      : `M${x1},${y1} C${x1},${(y1 + y2) / 2} ${x2},${(y1 + y2) / 2} ${x2},${y2}`;
    return { ...e, path, feedback };
  });
  return { nodes, edges, width: width + 24, height };
}
