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
    platform: headerValue(text, 'Platform')?.replace(/\s*\[.*\]\s*$/, '') || null,
    logicalSystem: headerValue(text, 'Logical system'),
    serverVersion: headerValue(text, 'Server version'),
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

/** CUBE / ODSO / MPRO metadata read. */
export function parseProvider(text) {
  const s = sections(text);
  const head = s._head || '';
  const parts = [...(s['Part Providers'] || '').matchAll(/^\s+\d+\s+([A-Z]{4})\s+(\S+)/gm)]
    .map((m) => ({ type: m[1], name: m[2] }));
  return {
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
