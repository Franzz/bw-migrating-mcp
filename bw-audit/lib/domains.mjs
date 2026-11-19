// Domains: the top-level InfoAreas of the BW InfoArea tree. Every scored object is
// assigned to one domain, with the reason (domainVia) shown in the page:
//   providers            their own InfoArea
//   transformations/DTPs the domain of their target (InfoSources resolved forward, else by their
//                        own InfoArea), else their source
//   master data (IOBJ)   the domain whose providers use the InfoObject most, else its own InfoArea
//   queries / agg. levels the domain of their InfoProvider, else their InfoArea
//   process chains       the domain most of their DTP steps load
//   AfO workbooks        the domain most of their queries belong to
//   variables            the domain of their reference InfoObject
//   source systems       the domain they feed, or CROSS when they feed several
// Objects with nothing to go on are UNASSIGNED.

export const UNASSIGNED = '~unassigned';
export const CROSS = '~cross';

const PROVIDERS = ['ADSO', 'CUBE', 'ODSO', 'MPRO', 'HCPR'];

/** areas: [{ name, label, parent }] → { rootOf(name), domains } */
export function areaTree(areas = []) {
  const byName = new Map(areas.map((a) => [a.name, a]));
  const rootOf = (name) => {
    let a = byName.get(name);
    if (!a) return null;
    const seen = new Set();
    while (a.parent && byName.has(a.parent) && !seen.has(a.parent)) {
      seen.add(a.name);
      a = byName.get(a.parent);
    }
    return a.name;
  };
  const domains = {};
  for (const a of areas) {
    const root = rootOf(a.name);
    domains[root] ||= { key: root, label: byName.get(root)?.label || root, areas: [] };
    domains[root].areas.push(a.name);
  }
  domains[CROSS] = { key: CROSS, label: 'Cross-domain', areas: [], special: true };
  domains[UNASSIGNED] = { key: UNASSIGNED, label: 'Unassigned', areas: [], special: true };
  return { rootOf, domains };
}

/** The most frequent key of a { key: count } map; ties go to `prefer`, then by name. */
function top(counts, prefer) {
  const entries = Object.entries(counts).filter(([k]) => k && k !== UNASSIGNED);
  if (!entries.length) return null;
  const max = Math.max(...entries.map(([, n]) => n));
  const best = entries.filter(([, n]) => n === max).map(([k]) => k).sort();
  return best.includes(prefer) ? prefer : best[0];
}

function tally(list) {
  const out = {};
  for (const k of list) if (k) out[k] = (out[k] || 0) + 1;
  return out;
}

/**
 * Assign o.domain and o.domainVia on every object (mutates and returns objects).
 * areas: the InfoArea list with parents; infoSources: [{ name, infoArea }].
 */
export function assignDomains(objects, areas, { infoSources = [] } = {}) {
  const { rootOf, domains } = areaTree(areas);
  const label = (k) => domains[k]?.label || k;
  const set = (o, domain, via) => { o.domain = domain || UNASSIGNED; o.domainVia = domain ? via : (via || 'no InfoArea, provider or data flow to go on'); };

  // Providers, by name (names are unique across provider types in BW).
  const provider = new Map();
  for (const o of objects.filter((x) => PROVIDERS.includes(x.type))) {
    const root = rootOf(o.details?.infoArea);
    set(o, root, o.details?.infoArea ? `InfoArea ${o.details.infoArea}` : null);
    provider.set(o.name, o);
  }
  const byPrefix = (map, name) => {
    if (!name) return null;
    if (map.has(name)) return map.get(name);
    // Search descriptions cut names short ("UNIT_TES"); accept a unique prefix match.
    const hits = [...map.keys()].filter((k) => k.startsWith(name));
    return hits.length === 1 ? map.get(hits[0]) : null;
  };

  // InfoObject usage: domain → number of providers using it.
  const usage = new Map();
  for (const p of provider.values()) {
    if (p.domain === UNASSIGNED) continue;
    for (const i of p.details?.infoObjects || []) {
      const u = usage.get(i) || {};
      u[p.domain] = (u[p.domain] || 0) + 1;
      usage.set(i, u);
    }
  }
  const iobjObjects = new Map(objects.filter((o) => o.type === 'IOBJ').map((o) => [o.name, o]));
  const iobjDomain = (name) => {
    const own = rootOf(iobjObjects.get(name)?.details?.infoArea);
    const u = usage.get(name) || {};
    const best = top(u, own);
    if (best) return { domain: best, via: `most used in ${label(best)} (${u[best]} of ${Object.values(u).reduce((a, b) => a + b, 0)} provider(s))`, usage: u };
    if (own) return { domain: own, via: `not used in any provider; own InfoArea ${iobjObjects.get(name).details.infoArea}`, usage: u };
    return { domain: null, via: null, usage: u };
  };
  for (const o of iobjObjects.values()) {
    const d = iobjDomain(o.name);
    set(o, d.domain, d.via);
    o.details.usage = d.usage;
  }
  const iobjDomainOf = (name) => {
    const hit = byPrefix(iobjObjects, name);
    return hit ? { domain: hit.domain === UNASSIGNED ? null : hit.domain, via: `master data ${hit.name}` } : iobjDomain(name);
  };

  // InfoSources: resolved forward, through the transformations that read them.
  const trcs = infoSources.filter((t) => t && t.infoArea);
  const flowObjs = objects.filter((o) => ['TRFN', 'DTPA', 'UPDR', 'ISTS'].includes(o.type) && o.details?.flow);
  const endpoint = (ep, seen = new Set()) => {
    if (!ep) return null;
    if (PROVIDERS.includes(ep.type)) {
      const p = byPrefix(provider, ep.name);
      return p && p.domain !== UNASSIGNED ? { domain: p.domain, via: `${ep.type} ${p.name}` } : null;
    }
    if (ep.type === 'IOBJ') {
      const d = iobjDomainOf(ep.name);
      return d.domain ? { domain: d.domain, via: `IOBJ ${ep.name} (${d.via})` } : null;
    }
    if (ep.type === 'TRCS') {
      if (seen.has(ep.name)) return null;
      seen.add(ep.name);
      const next = flowObjs.filter((f) => f.type === 'TRFN' && f.details.flow.source.type === 'TRCS' && f.details.flow.source.name.startsWith(ep.name));
      const ds = next.map((f) => endpoint(f.details.flow.target, seen)).filter(Boolean);
      const best = top(tally(ds.map((d) => d.domain)));
      if (best) return { domain: best, via: `InfoSource ${ep.name} → ${ds.find((d) => d.domain === best).via}` };
      const own = trcs.find((t) => t.name.startsWith(ep.name));
      const root = rootOf(own?.infoArea);
      return root ? { domain: root, via: `InfoSource ${own.name} in InfoArea ${own.infoArea}` } : null;
    }
    return null;
  };
  for (const o of flowObjs) {
    const { source, target } = o.details.flow;
    const t = endpoint(target);
    const s = t ? null : endpoint(source);
    set(o, (t || s)?.domain, t ? `target ${t.via}` : s ? `source ${s.via}` : null);
  }
  for (const o of objects.filter((x) => (x.type === 'TRFN' || x.type === 'DTPA') && !x.details?.flow)) set(o, null);

  const providerDomain = (name, infoArea) => {
    const p = byPrefix(provider, name);
    if (p && p.domain !== UNASSIGNED) return { domain: p.domain, via: `InfoProvider ${p.name}` };
    const root = rootOf(infoArea);
    if (root) return { domain: root, via: `InfoArea ${infoArea}` };
    return { domain: null, via: infoArea ? `InfoArea ${infoArea} is not in the InfoArea tree` : null };
  };
  const queries = new Map();
  for (const o of objects.filter((x) => x.type === 'QUERY')) {
    const d = providerDomain(o.details?.provider, o.details?.infoArea);
    set(o, d.domain, d.via);
    queries.set(o.name, o);
  }
  for (const o of objects.filter((x) => x.type === 'ALVL')) {
    const d = providerDomain(o.details?.provider, o.details?.infoArea);
    set(o, d.domain, d.via);
  }
  for (const o of objects.filter((x) => x.type === 'AFO')) {
    const ds = (o.details?.queries || []).map((q) => queries.get(q)?.domain).filter((d) => d && d !== UNASSIGNED);
    const best = top(tally(ds));
    set(o, best, best ? `${tally(ds)[best]} of ${o.details.queries.length} query data source(s)` : null);
  }
  for (const o of objects.filter((x) => x.type === 'VARIABLE')) {
    const name = o.details?.info_object;
    const d = name ? iobjDomainOf(name) : {};
    set(o, d.domain, d.domain ? `reference InfoObject ${name}` : null);
  }
  const dtps = new Map(objects.filter((o) => o.type === 'DTPA').map((o) => [o.name, o]));
  for (const o of objects.filter((x) => x.type === 'RSPC')) {
    const ds = (o.details?.steps || []).map((s) => dtps.get(s.variant)?.domain).filter((d) => d && d !== UNASSIGNED);
    const best = top(tally(ds));
    set(o, best, best ? `${tally(ds)[best]} DTP step(s) load it` : null);
  }
  for (const o of objects.filter((x) => x.type === 'LSYS')) {
    const fed = new Set(flowObjs.filter((f) => f.details.flow.source.sourceSystem === o.name && f.domain !== UNASSIGNED).map((f) => f.domain));
    if (fed.size === 1) set(o, [...fed][0], 'the only domain it feeds');
    else if (fed.size > 1) set(o, CROSS, `feeds ${fed.size} domains: ${[...fed].map(label).join(', ')}`);
    else set(o, null, 'feeds no transformation');
  }
  for (const o of objects) if (!o.domain) set(o, null);
  return { objects, domains };
}
