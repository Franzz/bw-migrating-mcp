// Parsers for the text that bw-mcp returns. They are tolerant on purpose: a line the
// parser does not understand is skipped, never fatal.

/** Split "── Title (n) ──" sections. Returns { title: body }. */
export function sections(text) {
  const out = {};
  let current = '_head';
  out[current] = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^──\s+(.+?)\s+──\s*$/);
    if (m) {
      current = m[1].replace(/\s*\(\d+.*?\)\s*$/, '').trim();
      out[current] = [];
      continue;
    }
    out[current].push(line);
  }
  for (const k of Object.keys(out)) out[k] = out[k].join('\n');
  return out;
}

/** Count in a section title such as "Steps (3, in execution order)". */
export function sectionCount(text, title) {
  const m = text.match(new RegExp(`──\\s+${title}\\s+\\((\\d+)`));
  return m ? Number(m[1]) : 0;
}

/** bw_find operation=search */
export function parseSearch(text) {
  const items = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*\d+\.\s+(\S+)\s+\(([A-Z0-9]+)\)\s+—\s+(\w+)(?:\s+—\s+"(.*)")?\s*$/);
    if (!m) continue;
    const pathLine = lines[i + 1]?.match(/Path:\s+(\S+)/);
    const p = pathLine?.[1] || '';
    items.push({
      name: m[1],
      type: m[2],
      status: m[3],
      description: (m[4] || '').replace(/\s{2,}/g, ' ').trim(),
      path: p,
      subtype: p.match(/\/sap\/bw\/modeling\/([a-z0-9]+)\//)?.[1] || null,
    });
  }
  return items;
}

/** "Label:   value" header lines. */
export function headerValue(text, label) {
  const m = text.match(new RegExp(`^\\s*${label}:\\s*(.+)$`, 'm'));
  return m ? m[1].trim() : null;
}

/** bw_find operation=system_profile */
export function parseSystemProfile(text) {
  const unavailable = [...text.matchAll(/^(.+?)\s{2,}unavailable — missing: (.+)$/gm)]
    .map((m) => ({ area: m[1].trim(), missing: m[2].trim() }));
  return {
    // bw-mcp (upstream wording) says "7.5 or lower" for every non-BW/4HANA release, 7.58
    // embedded in S/4HANA included; the release itself comes from the Software line.
    platform: headerValue(text, 'Platform')?.replace(/\s*\[.*\]\s*$/, '').replace(/\(7\.5 or lower\)/, '(not BW/4HANA)') || null,
    logicalSystem: headerValue(text, 'Logical system'),
    // The installed release (CVERS). The modeling backend number is kept apart: it is not
    // the SAP_BW release, and showing it as the server version read as one.
    software: headerValue(text, 'Software')?.replace(/^\?.*$/, '') || null,
    backendVersion: headerValue(text, 'Server version'),
    database: headerValue(text, 'Database'),
    planning: headerValue(text, 'Planning'),
    classic: /classic SAP BW/i.test(text),
    unavailable,
  };
}

const ABAP_PATTERNS = [
  ['db_select', /\bSELECT\b/i, 'database SELECT'],
  ['read_table', /\bREAD\s+TABLE\b/i, 'internal table lookup'],
  ['loop', /\bLOOP\s+AT\b/i, 'LOOP over tables'],
  ['call_function', /\bCALL\s+FUNCTION\b/i, 'function module call'],
  ['method_call', /\bCALL\s+METHOD\b|=>|->\w+\(/i, 'class/method call'],
  ['master_data', /\/BI[0C]\/[MPQXYT]\w+|\bRSDMD_|\bRRSV_/i, 'master data / BW API access'],
  ['dynamic', /\bASSIGN\b.*\(|\bCREATE\s+DATA\b|\bFIELD-SYMBOLS\b/i, 'dynamic programming'],
  ['exceptions', /CX_RSROUT_(ABORT|SKIP_RECORD)|RAISE\s+EXCEPTION/i, 'record skip / abort logic'],
];

/** Effective ABAP statements: not blank, not comments, not the generated template. */
export function abapStats(code) {
  const lines = code.split('\n').map((l) => l.trim()).filter(Boolean);
  const effective = lines.filter((l) => !l.startsWith('*') && !l.startsWith('"') && !l.startsWith('...'));
  const body = effective.join('\n');
  const patterns = ABAP_PATTERNS.filter(([, re]) => re.test(body)).map(([key, , label]) => ({ key, label }));
  return { lines: effective.length, patterns };
}

/** bw_find metadata_tables TRFN */
export function parseTransformation(text) {
  const s = sections(text);
  const head = s._head || '';
  const routines = [];
  let current = null;
  for (const line of (s.Routines || '').split('\n')) {
    const block = line.match(/^ {2}(\S[^:]*?):\s*(.*)$/);
    if (block && !/^ {4}/.test(line)) {
      if (current) routines.push(current);
      const none = block[2].trim() === '(none)';
      current = none ? null : { kind: block[1].trim(), code: block[2] ? `${block[2]}\n` : '' };
      continue;
    }
    if (current) current.code += `${line}\n`;
  }
  if (current) routines.push(current);

  const classified = routines.map((r) => {
    const k = r.kind.toLowerCase();
    const kind = k.startsWith('start') ? 'start'
      : k.startsWith('end') ? 'end'
      : k.startsWith('expert') ? 'expert'
      : k.startsWith('global') ? 'global'
      : 'field';
    return { kind, label: r.kind, ...abapStats(r.code) };
  }).filter((r) => r.lines > 0 || r.kind === 'expert');

  const ruleTypes = {};
  for (const m of (s['Field Mappings'] || '').matchAll(/^\s*\[([A-Z_]+)/gm)) {
    ruleTypes[m[1]] = (ruleTypes[m[1]] || 0) + 1;
  }
  const endpoint = (label) => {
    const v = headerValue(head, label);
    if (!v) return null;
    const [type, ...rest] = v.split(/\s+/);
    return { type, name: rest[0] || '', extra: rest.slice(1).join(' ') || null };
  };
  return {
    status: headerValue(head, 'Status'),
    source: endpoint('Source(?!: metadata)'),
    target: endpoint('Target'),
    routines: classified,
    ruleTypes,
    abapLines: classified.reduce((n, r) => n + r.lines, 0),
    patterns: [...new Map(classified.flatMap((r) => r.patterns).map((p) => [p.key, p])).values()],
  };
}

// ---------- 3.x data flow (bw_find metadata_tables UPDR / ISTS / ISFS / ISTD) ----------

/** "[active, routines 2, start routine, ...]" -> { version: 'active', bits: [...] } */
function bracket(text) {
  const bits = text.split(', ').map((b) => b.trim());
  return { version: bits[0], active: bits[0] === 'active', bits };
}

/** UPDR "*": "  <id>  <target> <- <InfoSource>  [active, routines 2, start routine, ...]" */
export function parseUpdateRuleList(text) {
  return [...text.matchAll(/^ {2}(\S+) {2}(\S+) <- (\S+) {2}\[(.+)\]$/gm)].map((m) => {
    const b = bracket(m[4]);
    return {
      id: m[1], target: m[2], infoSource: m[3], version: b.version, active: b.active,
      routines: Number(m[4].match(/routines (\d+)/)?.[1] || 0), startRoutine: b.bits.includes('start routine'),
    };
  });
}

/** ISTS "*": "  <DataSource>  <source system> -> <InfoSource>  [active, transaction data, transfer structure X]" */
export function parseTransferRuleList(text) {
  return [...text.matchAll(/^ {2}(\S+) {2}(\S+) -> (\S+) {2}\[(.+)\]$/gm)].map((m) => {
    const b = bracket(m[4]);
    return {
      dataSource: m[1], sourceSystem: m[2], infoSource: m[3], version: b.version, active: b.active,
      transferStructure: m[4].match(/transfer structure (\S+)/)?.[1] || null,
    };
  });
}

/** ISFS "*": "  <DataSource>  <source system>[ — text]  [active, transaction data, export DataSource (generated), ...]" */
export function parseDataSource3xList(text) {
  return [...text.matchAll(/^ {2}(\S+) {2}(\S+)(?: — (.*?))? {2}\[(.+)\]$/gm)].map((m) => {
    const b = bracket(m[4]);
    return {
      name: m[1], sourceSystem: m[2], description: m[3] || '', version: b.version, active: b.active,
      export: b.bits.includes('export DataSource (generated)'), migrated: b.bits.includes('migrated to RSDS'),
      feeds: m[4].match(/feeds (\S+)/)?.[1] || null,
    };
  });
}

/** ISTD "*": "  <InfoSource>[ — text]  [active, generated from DSO, DM]" */
export function parseInfoSource3xList(text) {
  return [...text.matchAll(/^ {2}(\S+)(?: — (.*?))? {2}\[(.+)\]$/gm)].map((m) => {
    const b = bracket(m[3]);
    return { name: m[1], description: m[2] || '', version: b.version, active: b.active, generated: /generated from/.test(m[3]) };
  });
}

/** UPDR / ISTS single read: routines as for transformations, rule kinds from the rule sections. */
export function parseFlow3x(text) {
  const t = parseTransformation(text);
  const s = sections(text);
  const ruleTypes = {};
  for (const key of ['Key Figure Rules', 'Characteristic Rules', 'Rules']) {
    for (const m of (s[key] || '').matchAll(/^\s*\[([A-Z_]+)\]/gm)) ruleTypes[m[1]] = (ruleTypes[m[1]] || 0) + 1;
  }
  const head = s._head || '';
  return {
    version: headerValue(head, 'Version')?.slice(0, 1) || null,
    target: headerValue(head, 'Target'),
    infoSource: headerValue(head, 'InfoSource')?.split(' — ')[0] || null,
    dataSource: headerValue(head, 'DataSource')?.split(' ')[0] || null,
    expertMode: headerValue(head, 'Expert mode') === 'yes',
    routines: t.routines, abapLines: t.abapLines, patterns: t.patterns, ruleTypes,
  };
}

/** Load history section of ADSO / ODSO / CUBE / MPRO metadata reads. */
export function parseLoadHistory(text) {
  const s = sections(text);
  const body = s['Load History'] ?? '';
  if (!body || /no requests/i.test(body)) return { requests: 0, lastLoad: null };
  const dates = [...body.matchAll(/\b(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}(?::\d{2})?))?/g)]
    .map((m) => `${m[1]}${m[2] ? ` ${m[2]}` : ''}`)
    .sort();
  const rows = body.split('\n').filter((l) => /\b\d{4}-\d{2}-\d{2}\b/.test(l)).length;
  return { requests: rows, lastLoad: dates.at(-1) || null };
}

/** Metadata tables write the namespace slashes as dollars: $ERP$PLAMT is /ERP/PLAMT. */
export function iobjName(name = '') {
  return name.replace(/^\$([^$]+)\$/, '/$1/');
}

/**
 * The characteristics a provider uses, from the "Characteristics" section of a metadata
 * read: INFOOBJECT column, navigation attributes (A__B) counted as their base A.
 */
export function providerInfoObjects(text) {
  const body = sections(text).Characteristics || '';
  const out = new Set();
  for (const line of body.split('\n')) {
    const m = line.match(/^ {2}(\S+)/);
    if (!m || m[1] === 'INFOOBJECT') continue;
    out.add(iobjName(m[1].split('__')[0]));
  }
  return [...out];
}

/** CUBE / ODSO / MPRO metadata read. */
export function parseProvider(text) {
  const s = sections(text);
  const head = s._head || '';
  const parts = [...(s['Part Providers'] || '').matchAll(/^\s+\d+\s+([A-Z]{4})\s+(\S+)/gm)]
    .map((m) => ({ type: m[1], name: m[2] }));
  return {
    infoObjects: providerInfoObjects(text),
    description: headerValue(head, 'Description'),
    infoArea: headerValue(head, 'InfoArea'),
    providerType: headerValue(head, 'Type'),
    functionModule: headerValue(head, 'Function module'),
    dimensions: sectionCount(text, 'Dimensions'),
    characteristics: sectionCount(text, 'Characteristics'),
    keyFigures: sectionCount(text, 'Key Figures'),
    parts,
    ...parseLoadHistory(text),
  };
}

/** bw_read type=adso (text). */
export function parseAdso(text) {
  const flag = (re) => new RegExp(`(${re})[^:\\n]*:\\s*true`, 'i').test(text);
  return {
    infoArea: headerValue(text, 'InfoArea'),
    package: headerValue(text, 'Package'),
    createdBy: headerValue(text, 'Created')?.match(/\(([^)]+)\)/)?.[1] || null,
    adsoType: text.match(/adso_type:\s*([\w-]+)/)?.[1] || null,
    planning: flag('Planung|Planning'),
    inventory: flag('Bestand|Inventory'),
    externalHanaView: flag('HANA-View|HANA View'),
    writeInterface: flag('Schreib-Interface|Write Interface'),
    fields: sectionCount(text, 'Fields'),
  };
}

/** bw_read type=adso format=raw: the InfoObjects behind the aDSO fields. */
export function adsoInfoObjects(xml) {
  const out = new Set();
  for (const m of xml.matchAll(/<element\b[^>]*\binfoObjectName="([^"]+)"/g)) out.add(m[1]);
  return [...out];
}

/** bw_read type=alvl (text). */
export function parseAggregationLevel(text) {
  const provider = headerValue(text, 'InfoProvider');
  return {
    infoArea: headerValue(text, 'InfoArea'),
    provider: provider ? iobjName(provider.split(/\s+/)[0]) : null,
  };
}

/** bw_read type=iobj (XML behind a one-line header): master data properties. */
export function parseInfoObject(text) {
  const has = (re) => re.test(text);
  return {
    infoArea: text.match(/<infoArea>([^<]+)<\/infoArea>/)?.[1] || null,
    iobjType: text.match(/<infoObjectType>([^<]+)<\/infoObjectType>/)?.[1] || null,
    masterData: has(/<masterDataProperties[^>]*withMasterData="true"/),
    texts: has(/<textProperties[^>]*(?:shortTextAvailable|mediumTextAvailable|longTextAvailable)="true"/),
    timeDependent: has(/timeDependentTextAvailable="true"/) || has(/<attributeN\b[^>]*timeDependent="true"/),
    hierarchies: has(/<hierarchyProperties[^>]*withHierarchies="true"/),
    attributes: (text.match(/<attributeN\b/g) || []).length,
    createdBy: text.match(/adtcore:createdBy="([^"]+)"/)?.[1] || null,
  };
}

/** bw_find metadata_tables RSPC */
export function parseChain(text) {
  const s = sections(text);
  const steps = [...(s.Steps || '').matchAll(/^ {2}([A-Z][A-Z0-9_]+)\s{2,}(\S+)/gm)]
    .map((m) => ({ processType: m[1], variant: m[2] }));
  return {
    description: headerValue(s._head || '', 'Description'),
    status: headerValue(s._head || '', 'Status'),
    steps,
  };
}

/** bw_find metadata_tables RSPCLOG with a pattern. */
export function parseChainStatus(text) {
  const out = [];
  const body = text.split(/──\s+Last run per chain[^\n]*\n/)[1] || '';
  for (const line of body.split('\n')) {
    if (!line.trim() || /^\s*STATUS\s+START/.test(line) || /^A "!"/.test(line.trim())) continue;
    const tokens = line.trim().split(/\s+/);
    const chain = tokens.at(-1);
    if (!/^[A-Z0-9_\/]+$/.test(chain)) continue;
    const color = line.match(/\b(green|red|yellow)\b/)?.[1] || 'none';
    const date = line.match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/)?.[0] || null;
    const statusText = color === 'none'
      ? (line.match(/never run/) ? 'never run' : 'unknown')
      : line.slice(line.indexOf(color) + color.length, date ? line.indexOf(date) : undefined).trim();
    out.push({ chain, color, statusText: statusText || color, lastStart: date });
  }
  return out;
}

/** bw_read type=query (text). */
export function parseQuery(text) {
  const head = text.split('\n──')[0];
  const count = (label) => {
    const m = text.match(new RegExp(`${label}\\s*\\((\\d+)\\)`, 'i'));
    return m ? Number(m[1]) : 0;
  };
  const provider = headerValue(head, 'InfoProvider');
  return {
    provider: provider?.split(/\s+/)[0] || null,
    providerKind: provider?.match(/\(([^)]+)\)/)?.[1] || null,
    infoArea: headerValue(head, 'InfoArea')?.split(/\s+/)[0] || null,
    changedBy: headerValue(head, 'Status')?.match(/By:\s*(\S+)/)?.[1] || null,
    variables: count('Variables'),
    ckf: count('Calculated (?:Key Figures|Measures)'),
    rkf: count('Restricted (?:Key Figures|Measures)'),
    exceptions: count('Exceptions'),
    cells: count('Cell(?: Definitions)?'),
    rows: count('ROWS'),
    columns: count('COLUMNS'),
    free: count('FREE'),
    hasHierarchy: /hierarch/i.test(text),
  };
}

/** bw_find afo_workbooks */
export function parseWorkbooks(text) {
  const blocks = text.split(/\n(?=\S+ — )/).slice(1);
  return blocks.map((b) => {
    const [first, ...rest] = b.split('\n');
    const m = first.match(/^(\S+) — (.*)$/);
    const body = rest.join('\n');
    const changed = body.match(/last changed (\S+ \S+) UTC by (\S+)/);
    const queries = [...body.matchAll(/query (\S+)/g)].map((x) => x[1]);
    const planning = [...body.matchAll(/planning (?:sequence|function) (\S+)/g)].map((x) => x[1]);
    return {
      name: m?.[1], description: m?.[2] || '',
      lastChanged: changed?.[1] || null, changedBy: changed?.[2] || null,
      queries: [...new Set(queries)], planning: [...new Set(planning)],
    };
  }).filter((w) => w.name);
}

/** SAP-delivered (or partner) namespaces. /BIC/ is the customer namespace. */
export function isSapName(name = '') {
  if (/^0/.test(name)) return true;
  if (name.startsWith('/BIC/')) return false;
  return /^\/[^/]+\//.test(name);
}
