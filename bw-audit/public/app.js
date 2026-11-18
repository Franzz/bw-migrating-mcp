import { marked } from '/vendor/marked.js';
import DOMPurify from '/vendor/purify.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = new Intl.NumberFormat('en');

const TYPE_LABEL = {
  ADSO: 'aDSO', ODSO: 'Classic DSO', CUBE: 'InfoCube', MPRO: 'MultiProvider', HCPR: 'CompositeProvider',
  TRFN: 'Transformation', DTPA: 'DTP', RSPC: 'Process chain', QUERY: 'Query', VARIABLE: 'Variable',
  AFO: 'AfO workbook', ALVL: 'Aggregation level', LSYS: 'Source system',
};
const SEVERITY = {
  critical: { label: 'Critical', icon: '!' },
  serious: { label: 'Serious', icon: '!' },
  warning: { label: 'Warning', icon: '–' },
  good: { label: 'Opportunity', icon: '✓' },
};

const TARGET_KEY = 'bw-audit-target';
const storedTarget = () => { try { return localStorage.getItem(TARGET_KEY); } catch { return null; } };

const state = {
  audit: null,
  targets: [],
  target: storedTarget() || 'generic',
  scope: 'custom',
  tab: 'objects',
  sort: { key: 'difficulty', dir: 'desc' },
  filters: { search: '', category: '', type: '', min: 1, ids: null, idsLabel: '' },
  expanded: new Set(),
  chatEnabled: false,
  sessionId: null,
  chatBusy: false,
  abort: null,
};

// ---------------------------------------------------------------- data

async function fetchAudit() {
  const res = await fetch(`/api/audit?target=${encodeURIComponent(state.target)}`);
  return res.json();
}

async function load() {
  const data = await fetchAudit();
  state.targets = data.targets || [];
  if (!state.targets.some((t) => t.key === state.target)) state.target = 'generic';
  renderTargets();
  state.audit = data.audit;
  state.chatEnabled = data.chat;
  state.chatBackend = data.chatBackend;
  render();
  renderChatIntro();
  if (data.running) runAudit();
}

function inScope(o) {
  return state.scope === 'all' || o.origin !== 'sap';
}

function summary() {
  return state.audit.summary[state.scope === 'all' ? 'all' : 'custom'];
}

// ---------------------------------------------------------------- target

function currentTarget() {
  return state.targets.find((t) => t.key === state.target) || { key: 'generic', label: 'Generic platform', description: '' };
}

function renderTargets() {
  $('#target-options').innerHTML = state.targets.map((t) => `
    <label class="target-option">
      <input type="radio" name="target" value="${esc(t.key)}"${t.key === state.target ? ' checked' : ''}>
      <span>${esc(t.label)}</span>
    </label>`).join('');
  $('#target-desc').textContent = currentTarget().description;
  $$('#target-options input').forEach((r) => r.addEventListener('change', () => r.checked && setTarget(r.value)));
}

async function setTarget(key) {
  if (key === state.target) return;
  state.target = key;
  try { localStorage.setItem(TARGET_KEY, key); } catch { /* per-browser convenience only */ }
  $('#target-desc').textContent = currentTarget().description;
  const data = await fetchAudit();
  if (state.target !== key) return; // a later click won
  state.audit = data.audit;
  state.expanded.clear();
  render();
  if (state.sessionId) {
    const log = $('#chat-log');
    log.insertAdjacentHTML('beforeend', `<div class="msg notice">Target set to <strong>${esc(currentTarget().label)}</strong>. Next answers use it.</div>`);
    log.scrollTop = log.scrollHeight;
  }
}

// ---------------------------------------------------------------- render

function render() {
  const a = state.audit;
  $('#empty').hidden = Boolean(a);
  $('#content').hidden = !a;
  if (!a) return;
  const sys = a.system;
  $('#system-line').textContent = [
    sys.logicalSystem, sys.platform, sys.serverVersion && `server ${sys.serverVersion}`,
    sys.database, `audited ${new Date(a.generatedAt).toLocaleString()}`, `target ${a.target?.label || 'Generic platform'}`,
  ].filter(Boolean).join(' · ');
  renderKpis();
  renderCategoryChart();
  renderDistributionChart();
  renderFindings();
  renderFilters();
  renderObjects();
  renderFlows();
  renderChains();
  renderSources();
  renderInventory();
  $('#footnote').textContent = `Snapshot read in ${a.durationSec}s. ${a.errors.length ? `${a.errors.length} object(s) could not be read.` : 'Every object was read.'} ${a.target && a.target.key !== 'generic' ? `Scores come from fixed rules, adjusted for ${a.target.label}; each object lists the reasons.` : 'Scores come from fixed, platform-agnostic rules.'} Ask Claude to challenge any of them.`;
}

function renderKpis() {
  const s = summary();
  const objs = state.audit.objects.filter((o) => o.difficulty && inScope(o));
  const abap = objs.filter((o) => o.type === 'TRFN').reduce((n, o) => n + (o.details.abapLines || 0), 0);
  const withRoutines = objs.filter((o) => o.type === 'TRFN' && o.details.routines?.length).length;
  const decom = objs.filter((o) => o.flags.some((f) => ['never loaded', 'never run', 'inactive'].includes(f))).length;
  const tiles = [
    { hero: true, label: 'Migration complexity', value: `${s.index}<small> / 100</small>`, note: s.rating, meter: s.index },
    { label: 'Objects in scope', value: fmt.format(s.objects), note: state.scope === 'all' ? 'including SAP content' : 'customer objects' },
    { label: 'High difficulty', value: fmt.format(s.highDifficulty), note: 'difficulty 4 or 5' },
    { label: 'ABAP in transformations', value: fmt.format(abap), note: `lines, in ${withRoutines} transformation(s)` },
    { label: 'Decommission candidates', value: fmt.format(decom), note: 'never loaded, never run or inactive' },
  ];
  $('#kpis').innerHTML = tiles.map((t) => `
    <div class="kpi${t.hero ? ' hero' : ''}">
      <div class="label">${esc(t.label)}</div>
      <div class="value">${t.value}</div>
      <div class="note">${esc(t.note)}</div>
      ${t.meter != null ? `<div class="meter" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${t.meter}"><div style="width:${t.meter}%"></div></div>` : ''}
    </div>`).join('');
}

// Horizontal bar with a 4px rounded data end, square at the baseline.
function hbarPath(x0, x1, y, h, r = 4) {
  const rr = Math.min(r, (x1 - x0) / 2, h / 2);
  return `M${x0},${y}H${x1 - rr}Q${x1},${y} ${x1},${y + rr}V${y + h - rr}Q${x1},${y + h} ${x1 - rr},${y + h}H${x0}Z`;
}
function colPath(x, w, y0, y1, r = 4) {
  const rr = Math.min(r, w / 2, (y0 - y1) / 2);
  return `M${x},${y0}V${y1 + rr}Q${x},${y1} ${x + rr},${y1}H${x + w - rr}Q${x + w},${y1} ${x + w},${y1 + rr}V${y0}Z`;
}

function renderCategoryChart() {
  const cats = summary().byCategory;
  const el = $('#chart-categories');
  const W = Math.max(300, Math.round(el.clientWidth || 560));
  const labelW = W < 420 ? 128 : 170; const right = 78; const rowH = 34; const barH = 18; const top = 8;
  const H = top + cats.length * rowH + 22;
  const x = (v) => labelW + ((W - labelW - right) * v) / 5;
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Average difficulty by area">`;
  for (let t = 0; t <= 5; t++) {
    svg += `<line class="gridline" x1="${x(t)}" x2="${x(t)}" y1="${top - 4}" y2="${H - 20}"/>`;
    svg += `<text class="tick" x="${x(t)}" y="${H - 6}" text-anchor="middle">${t}</text>`;
  }
  svg += '<g class="bars">';
  cats.forEach((c, i) => {
    const y = top + i * rowH + (rowH - barH) / 2;
    svg += `<g class="bar-g" data-i="${i}">`;
    svg += `<text class="axis-label" x="${labelW - 10}" y="${y + barH / 2 + 4}" text-anchor="end">${esc(c.label)}</text>`;
    if (c.count) {
      svg += `<path class="mark" d="${hbarPath(x(0), x(c.average), y, barH)}" fill="var(--bar)"/>`;
      svg += `<text class="value-label" x="${x(c.average) + 8}" y="${y + barH / 2 + 4}">${c.average.toFixed(1)}</text>`;
      svg += `<text class="tick" x="${x(c.average) + 34}" y="${y + barH / 2 + 4}">${c.count} obj.</text>`;
    } else {
      svg += `<text class="tick" x="${x(0) + 6}" y="${y + barH / 2 + 4}">no objects in scope</text>`;
    }
    svg += `<rect class="hit" x="0" y="${top + i * rowH}" width="${W}" height="${rowH}"/>`;
    svg += '</g>';
  });
  svg += '</g></svg>';
  el.innerHTML = svg;
  wireHover(el, '.bar-g', (g) => {
    const c = cats[g.dataset.i];
    return c.count
      ? `<strong>${esc(c.label)}</strong>Average difficulty ${c.average.toFixed(1)}<br>${c.count} object(s), ${c.high} at 4 or 5`
      : `<strong>${esc(c.label)}</strong>No objects in scope`;
  }, (g) => { state.filters.category = summary().byCategory[g.dataset.i].key; state.filters.ids = null; switchTab('objects'); renderFilters(); renderObjects(); scrollToTable(); });
}

function renderDistributionChart() {
  const dist = summary().distribution;
  const el = $('#chart-distribution');
  const W = Math.max(300, Math.round(el.clientWidth || 560)); const H = 230; const left = 36; const bottom = 40; const top = 22;
  const max = Math.max(1, ...dist.map((d) => d.count));
  const nice = niceMax(max);
  const plotW = W - left - 8;
  const band = plotW / dist.length;
  const colW = Math.min(24 * 2, band * 0.5);
  const y = (v) => H - bottom - ((H - bottom - top) * v) / nice;
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Objects by difficulty">`;
  for (const t of ticks(nice)) {
    svg += `<line class="gridline" x1="${left}" x2="${W - 8}" y1="${y(t)}" y2="${y(t)}"/>`;
    svg += `<text class="tick" x="${left - 6}" y="${y(t) + 4}" text-anchor="end">${fmt.format(t)}</text>`;
  }
  dist.forEach((d, i) => {
    const cx = left + band * i + band / 2;
    svg += `<g class="bar-g" data-i="${i}">`;
    if (d.count) svg += `<path class="mark" d="${colPath(cx - colW / 2, colW, y(0), y(d.count))}" fill="var(--d${d.level})"/>`;
    svg += `<text class="value-label" x="${cx}" y="${y(d.count) - 6}" text-anchor="middle">${fmt.format(d.count)}</text>`;
    svg += `<text class="axis-label" x="${cx}" y="${H - bottom + 18}" text-anchor="middle">${d.level}</text>`;
    svg += `<text class="tick" x="${cx}" y="${H - bottom + 33}" text-anchor="middle">${esc(d.label)}</text>`;
    svg += `<rect class="hit" x="${cx - band / 2}" y="${top - 10}" width="${band}" height="${H - top}"/>`;
    svg += '</g>';
  });
  svg += '</svg>';
  el.innerHTML = svg;
  const total = dist.reduce((n, d) => n + d.count, 0) || 1;
  wireHover(el, '.bar-g', (g) => {
    const d = dist[g.dataset.i];
    return `<strong>Difficulty ${d.level}: ${esc(d.label)}</strong>${fmt.format(d.count)} object(s), ${Math.round((d.count / total) * 100)}% of scope`;
  }, (g) => { state.filters.min = dist[g.dataset.i].level; state.filters.ids = null; switchTab('objects'); renderFilters(); renderObjects(); scrollToTable(); });
}

function niceMax(v) {
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}
function ticks(max) {
  const step = niceMax(max / 4);
  const out = [];
  for (let t = 0; t <= max + 1e-9; t += step) out.push(Math.round(t));
  return out;
}

const tooltip = $('#tooltip');
function wireHover(root, sel, html, onClick) {
  const groups = $$(sel, root);
  const svg = root.querySelector('svg');
  for (const g of groups) {
    g.addEventListener('mouseenter', () => { svg.classList.add('dim'); g.classList.add('active'); tooltip.innerHTML = html(g); tooltip.hidden = false; });
    g.addEventListener('mousemove', (e) => {
      const r = tooltip.getBoundingClientRect();
      tooltip.style.left = `${Math.min(e.clientX + 14, window.innerWidth - r.width - 8)}px`;
      tooltip.style.top = `${Math.max(8, e.clientY - r.height - 12)}px`;
    });
    g.addEventListener('mouseleave', () => { svg.classList.remove('dim'); g.classList.remove('active'); tooltip.hidden = true; });
    if (onClick) { g.style.cursor = 'pointer'; g.addEventListener('click', () => { tooltip.hidden = true; onClick(g); }); }
  }
}

function statusBadge(severity, label) {
  const s = SEVERITY[severity] || { label: label || severity, icon: '•' };
  return `<span class="status ${severity}"><span class="ico" aria-hidden="true">${s.icon}</span>${esc(label || s.label)}</span>`;
}

function renderFindings() {
  const byId = new Map(state.audit.objects.map((o) => [o.id, o]));
  const items = state.audit.findings.map((f) => {
    const objs = f.objects.map((id) => byId.get(id)).filter((o) => o && inScope(o));
    return { ...f, inScope: objs };
  }).filter((f) => f.inScope.length || f.objects.length === 0);
  $('#findings').innerHTML = items.length ? items.map((f, i) => `
    <li class="finding">
      ${statusBadge(f.severity)}
      <div>
        <h3>${esc(f.title)}${f.inScope.length ? ` · ${f.inScope.length}` : ''}</h3>
        <p>${esc(f.detail)}</p>
        ${f.inScope.length ? `<div class="objs">${f.inScope.slice(0, 10).map((o) => `<button class="chip" data-obj="${esc(o.id)}" title="${esc(o.description || '')}">${esc(shortName(o))}</button>`).join('')}${f.inScope.length > 10 ? `<button class="chip" data-finding="${i}">+${f.inScope.length - 10} more</button>` : ''}</div>` : ''}
      </div>
      ${f.inScope.length ? `<button class="btn small" data-ask-finding="${i}">Ask Claude</button>` : '<span></span>'}
    </li>`).join('') : '<li class="finding"><span></span><p>No findings in this scope.</p><span></span></li>';
  $$('#findings [data-obj]').forEach((b) => b.addEventListener('click', () => focusObjects([b.dataset.obj], b.textContent)));
  $$('#findings [data-finding]').forEach((b) => b.addEventListener('click', () => {
    const f = items[b.dataset.finding];
    focusObjects(f.inScope.map((o) => o.id), f.title);
  }));
  $$('#findings [data-ask-finding]').forEach((b) => b.addEventListener('click', () => {
    const f = items[b.dataset.askFinding];
    askClaude(`Finding "${f.title}" (${f.inScope.length} object(s): ${f.inScope.slice(0, 15).map((o) => `${o.type} ${o.name}`).join(', ')}${f.inScope.length > 15 ? ', …' : ''}). Look at these objects in BW, tell me what drives the difficulty, and how you would handle them in the migration.`);
  }));
}

function shortName(o) {
  if (o.type === 'TRFN' && o.details.flow) return `${o.details.flow.source.name} → ${o.details.flow.target.name}`;
  return o.name;
}

function focusObjects(ids, label) {
  state.filters = { search: '', category: '', type: '', min: 1, ids: new Set(ids), idsLabel: label };
  switchTab('objects');
  renderFilters();
  renderObjects();
  scrollToTable();
}
function scrollToTable() { $('.tabs').scrollIntoView({ behavior: 'smooth', block: 'start' }); }

function renderFilters() {
  const objs = state.audit.objects.filter((o) => o.difficulty && inScope(o));
  const cats = state.audit.categories;
  $('#f-category').innerHTML = '<option value="">All areas</option>' + Object.entries(cats)
    .map(([k, v]) => `<option value="${k}"${state.filters.category === k ? ' selected' : ''}>${esc(v.label)}</option>`).join('');
  const types = [...new Set(objs.map((o) => o.type))].sort();
  $('#f-type').innerHTML = '<option value="">All types</option>' + types
    .map((t) => `<option value="${t}"${state.filters.type === t ? ' selected' : ''}>${esc(TYPE_LABEL[t] || t)}</option>`).join('');
  $('#f-min').value = String(state.filters.min);
  $('#f-search').value = state.filters.search;
}

function difficultyCell(d) {
  if (!d) return '';
  const label = state.audit.levels[d];
  return `<span class="difficulty" style="--dc: var(--d${d})" title="${esc(label)}"><span class="dots" aria-hidden="true">${[1, 2, 3, 4, 5].map((i) => `<i class="${i <= d ? 'on' : ''}"></i>`).join('')}</span>${d} ${esc(label)}</span>`;
}

function filteredObjects() {
  const f = state.filters;
  const q = f.search.trim().toLowerCase();
  let list = state.audit.objects.filter((o) => o.difficulty && inScope(o));
  if (f.ids) list = list.filter((o) => f.ids.has(o.id));
  if (f.category) list = list.filter((o) => o.category === f.category);
  if (f.type) list = list.filter((o) => o.type === f.type);
  if (f.min > 1) list = list.filter((o) => o.difficulty >= f.min);
  if (q) list = list.filter((o) => `${o.name} ${o.description} ${shortName(o)}`.toLowerCase().includes(q));
  const { key, dir } = state.sort;
  const val = (o) => key === 'name' ? shortName(o).toLowerCase() : key === 'type' ? o.type : key === 'category' ? o.category : o.difficulty;
  list.sort((a, b) => {
    const va = val(a); const vb = val(b);
    const c = va < vb ? -1 : va > vb ? 1 : 0;
    return (dir === 'asc' ? c : -c) || shortName(a).localeCompare(shortName(b));
  });
  return list;
}

const OBJECT_LIMIT = 300;
function renderObjects() {
  const list = filteredObjects();
  const cats = state.audit.categories;
  const showOrigin = state.scope === 'all';
  const th = (key, label) => `<th class="sortable" data-sort="${key}" aria-sort="${state.sort.key === key ? (state.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}">${label}</th>`;
  const cols = showOrigin ? 7 : 6;
  let html = `<thead><tr>${th('difficulty', 'Difficulty')}${th('type', 'Type')}${th('name', 'Name')}<th>Description</th>${th('category', 'Area')}<th>Flags</th>${showOrigin ? '<th>Origin</th>' : ''}</tr></thead><tbody>`;
  for (const o of list.slice(0, OBJECT_LIMIT)) {
    const open = state.expanded.has(o.id);
    html += `<tr class="row${open ? ' expanded' : ''}" data-id="${esc(o.id)}" aria-expanded="${open}">
      <td>${difficultyCell(o.difficulty)}</td>
      <td>${esc(TYPE_LABEL[o.type] || o.type)}</td>
      <td class="mono">${esc(shortName(o))}</td>
      <td>${esc(o.type === 'TRFN' ? o.name : o.description)}</td>
      <td>${esc(cats[o.category]?.label || '')}</td>
      <td>${o.flags.map((f) => `<span class="flag">${esc(f)}</span>`).join('')}</td>
      ${showOrigin ? `<td>${o.origin === 'sap' ? 'SAP content' : 'Customer'}</td>` : ''}
    </tr>`;
    if (open) html += `<tr class="detail-row"><td colspan="${cols}">${objectDetail(o)}</td></tr>`;
  }
  html += '</tbody>';
  const table = $('#objects-table');
  table.innerHTML = html;
  $('#objects-note').innerHTML = `${fmt.format(list.length)} object(s)${list.length > OBJECT_LIMIT ? `, showing the first ${OBJECT_LIMIT}` : ''}${state.filters.ids ? ` · filtered on <strong>${esc(state.filters.idsLabel)}</strong> <button class="chip" id="clear-ids">clear</button>` : ''}. Click a row for the reasons behind its score.`;
  $('#clear-ids')?.addEventListener('click', () => { state.filters.ids = null; renderObjects(); });
  $$('th[data-sort]', table).forEach((h) => h.addEventListener('click', () => {
    const key = h.dataset.sort;
    state.sort = { key, dir: state.sort.key === key && state.sort.dir === 'desc' ? 'asc' : 'desc' };
    renderObjects();
  }));
  $$('tr.row', table).forEach((r) => r.addEventListener('click', () => {
    const id = r.dataset.id;
    if (state.expanded.has(id)) state.expanded.delete(id); else state.expanded.add(id);
    renderObjects();
  }));
  $$('[data-ask]', table).forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    const o = state.audit.objects.find((x) => x.id === b.dataset.ask);
    askClaude(`Analyse ${TYPE_LABEL[o.type] || o.type} ${o.name}${o.type === 'TRFN' && o.details.flow ? ` (${shortName(o)})` : ''}. The audit scored it ${o.difficulty}/5 because: ${o.reasons.join('; ')}. Read it in BW, check whether the score is right, and explain how you would migrate it.`);
  }));
}

function objectDetail(o) {
  const d = o.details || {};
  const kv = [];
  const add = (k, v) => { if (v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length)) kv.push(`<strong>${esc(k)}</strong> ${esc(Array.isArray(v) ? v.join(', ') : v)}`); };
  if (o.type === 'TRFN') {
    add('Flow', d.flow ? `${d.flow.source.type} ${d.flow.source.name}${d.flow.source.sourceSystem ? ` (${d.flow.source.sourceSystem})` : ''} → ${d.flow.target.type} ${d.flow.target.name}` : null);
    add('Routines', (d.routines || []).map((r) => `${r.kind} (${r.lines} lines)`));
    add('Rule types', Object.entries(d.ruleTypes || {}).map(([k, v]) => `${k} ${v}`));
    add('ABAP features', (d.patterns || []).map((p) => p.label));
  } else if (['CUBE', 'ODSO', 'MPRO'].includes(o.type)) {
    add('Type', d.providerType); add('InfoArea', d.infoArea); add('Function module', d.functionModule);
    add('Characteristics', d.characteristics); add('Key figures', d.keyFigures);
    add('Parts', (d.parts || []).map((p) => `${p.type} ${p.name}`));
    add('Load requests', d.requests); add('Last load', d.lastLoad);
  } else if (o.type === 'ADSO') {
    add('aDSO type', d.adsoType); add('InfoArea', d.infoArea); add('Fields', d.fields);
    add('Planning', d.planning ? 'yes' : null); add('Inventory', d.inventory ? 'yes' : null);
  } else if (o.type === 'HCPR') {
    add('Node', d.nodeType); add('Join', d.join); add('Inputs', d.inputProviders); add('Fields', d.fields);
  } else if (o.type === 'RSPC') {
    add('Last run', d.lastRun ? `${d.lastRun.statusText}${d.lastRun.lastStart ? `, ${d.lastRun.lastStart}` : ''}` : null);
    add('Steps', (d.steps || []).map((s) => `${s.processType} ${s.variant}`));
  } else if (o.type === 'QUERY') {
    add('InfoProvider', d.provider ? `${d.provider} (${d.providerKind})` : null);
    add('Layout', d.rows != null ? `${d.rows} rows, ${d.columns} columns, ${d.free} free` : null);
    add('Calculated / restricted', d.ckf != null ? `${d.ckf} / ${d.rkf}` : null);
  } else if (o.type === 'VARIABLE') {
    add('Processing', d.processing_type); add('InfoObject', d.info_object);
  } else if (o.type === 'AFO') {
    add('Queries', d.queries); add('Planning', d.planning); add('Last changed', d.lastChanged && `${d.lastChanged} by ${d.changedBy}`);
  } else if (o.type === 'LSYS') {
    add('Type', d.sourceSystemType);
  }
  return `<div><strong>Why ${o.difficulty}/5</strong><ul>${o.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
    ${kv.length ? `<div class="kv">${kv.join(' · ')}</div>` : ''}
    <div style="margin-top:10px"><button class="btn small primary" data-ask="${esc(o.id)}">Ask Claude about this object</button></div></div>`;
}

function renderFlows() {
  const flows = state.audit.flows.filter((f) => state.scope === 'all' || f.origin !== 'sap')
    .sort((a, b) => b.difficulty - a.difficulty || a.target.name.localeCompare(b.target.name));
  $('#flows-table').innerHTML = `<thead><tr><th>Difficulty</th><th>Source</th><th>Target</th><th>Routines</th><th class="num">ABAP lines</th><th>DTPs</th><th>Status</th></tr></thead><tbody>${
    flows.map((f) => `<tr class="row" data-id="TRFN:${esc(f.transformation)}">
      <td>${difficultyCell(f.difficulty)}</td>
      <td class="mono">${esc(f.source.type)} ${esc(f.source.name)}${f.source.sourceSystem ? ` <span class="flag">${esc(f.source.sourceSystem)}</span>` : ''}</td>
      <td class="mono">${esc(f.target.type)} ${esc(f.target.name)}</td>
      <td>${f.routines.length ? f.routines.map((r) => `<span class="flag">${esc(r)}</span>`).join('') : '–'}</td>
      <td class="num">${f.abapLines || '–'}</td>
      <td>${f.dtps.length ? f.dtps.map((d) => `<span class="flag" title="${esc(d.name)}">${esc(d.status)}</span>`).join('') : '–'}</td>
      <td>${esc(f.status)}</td></tr>`).join('')}</tbody>`;
  $$('#flows-table tr.row').forEach((r) => r.addEventListener('click', () => { state.expanded.add(r.dataset.id); focusObjects([r.dataset.id], r.dataset.id.slice(5)); }));
}

function chainStatus(run) {
  if (!run) return statusBadge('none', 'no run data');
  const sev = run.color === 'green' ? 'good' : run.color === 'red' ? 'critical' : run.color === 'yellow' ? 'warning' : 'none';
  return `<span class="status ${sev}"><span class="ico" aria-hidden="true">${sev === 'good' ? '✓' : sev === 'none' ? '–' : '!'}</span>${esc(run.statusText)}</span>`;
}

function renderChains() {
  const chains = state.audit.objects.filter((o) => o.type === 'RSPC' && inScope(o));
  $('#chains-table').innerHTML = `<thead><tr><th>Last run</th><th>Chain</th><th>Description</th><th>Started</th><th>Steps</th><th>Difficulty</th></tr></thead><tbody>${
    chains.map((c) => `<tr class="row" data-id="${esc(c.id)}">
      <td>${chainStatus(c.details.lastRun)}</td>
      <td class="mono">${esc(c.name)}</td>
      <td>${esc(c.description)}</td>
      <td>${esc(c.details.lastRun?.lastStart || '–')}</td>
      <td>${(c.details.steps || []).map((s) => `<span class="flag">${esc(s.processType)}</span>`).join('')}</td>
      <td>${difficultyCell(c.difficulty)}</td></tr>`).join('')}</tbody>`;
  $$('#chains-table tr.row').forEach((r) => r.addEventListener('click', () => { state.expanded.add(r.dataset.id); focusObjects([r.dataset.id], r.dataset.id.slice(5)); }));
}

function renderSources() {
  const src = state.audit.objects.filter((o) => o.type === 'LSYS');
  $('#sources-table').innerHTML = `<thead><tr><th>Source system</th><th>Description</th><th>Type</th><th>Difficulty</th><th>Why</th></tr></thead><tbody>${
    src.map((s) => `<tr><td class="mono">${esc(s.name)}</td><td>${esc(s.description)}</td><td class="mono">${esc(s.details.sourceSystemType)}</td><td>${difficultyCell(s.difficulty)}</td><td>${esc(s.reasons.join('; '))}</td></tr>`).join('')}</tbody>`;
}

function renderInventory() {
  const inv = Object.entries(state.audit.inventory).sort((a, b) => b[1].total - a[1].total);
  $('#inventory-table').innerHTML = `<thead><tr><th>Object type</th><th class="num">Total</th><th class="num">Customer</th><th class="num">SAP content</th><th class="num">Inactive</th></tr></thead><tbody>${
    inv.map(([k, v]) => `<tr><td>${esc(v.label)} <span class="flag">${esc(k)}</span></td><td class="num">${fmt.format(v.total)}</td><td class="num">${fmt.format(v.custom)}</td><td class="num">${fmt.format(v.sap)}</td><td class="num">${fmt.format(v.inactive)}</td></tr>`).join('')}</tbody>`;
}

function switchTab(tab) {
  state.tab = tab;
  $$('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  $$('.tab-panel').forEach((p) => { p.hidden = p.dataset.panel !== tab; });
}

// ---------------------------------------------------------------- audit run

async function runAudit() {
  const btn = $('#run-audit');
  btn.disabled = true;
  $('#progress').hidden = false;
  try {
    const res = await fetch('/api/audit/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: state.target }),
    });
    for await (const e of readSse(res)) {
      $('#progress-fill').style.width = `${e.pct}%`;
      $('#progress-text').textContent = e.detail;
      if (e.step === 'error') throw new Error(e.detail);
    }
    const data = await fetchAudit();
    state.audit = data.audit;
    state.expanded.clear();
    render();
    renderChatIntro();
    $('#progress').hidden = true;
  } catch (err) {
    $('#progress-text').textContent = `Audit failed: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

async function* readSse(res) {
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const line = chunk.split('\n').find((l) => l.startsWith('data: '));
      if (line) yield JSON.parse(line.slice(6));
    }
  }
}

// ---------------------------------------------------------------- chat

const SUGGESTIONS = [
  'Summarise the main migration risks of this BW system',
  'Read the ABAP routines and explain how to rebuild them',
  'Which objects can we leave out of the migration?',
  'Propose migration waves with a rough effort range',
];

function renderChatIntro() {
  const log = $('#chat-log');
  if (log.children.length && !log.querySelector('.intro')) return;
  log.innerHTML = state.chatEnabled
    ? `<div class="msg notice intro">Ask about the audit, any object in it, or the migration approach. Claude can read the live BW system through bw-mcp (read-only) to check details.<br><span class="card-sub">${state.chatBackend === 'claude-code' ? 'Runs through Claude Code with your Claude login.' : 'Runs on the Claude API with your API key.'}</span></div>`
    : `<div class="msg notice intro"><strong>Chat is not configured.</strong> Install Claude Code and sign in (<code>claude</code>), or set <code>ANTHROPIC_API_KEY</code> in <code>bw-audit/.env</code>, then restart <code>npm start</code>. The audit works without it.</div>`;
  $('#suggestions').innerHTML = state.chatEnabled
    ? SUGGESTIONS.map((s) => `<button class="chip" type="button">${esc(s)}</button>`).join('')
    : '';
  $$('#suggestions .chip').forEach((c) => c.addEventListener('click', () => askClaude(c.textContent)));
  setChatEnabled(state.chatEnabled);
}

function setChatEnabled(on) {
  $('#chat-input').disabled = !on;
  $('#chat-send').disabled = !on || state.chatBusy;
}

function openChat() { $('#chat').classList.add('open'); $('#chat-input').focus(); }

function askClaude(text) {
  openChat();
  if (!state.chatEnabled) return;
  if (state.chatBusy) { $('#chat-input').value = text; return; }
  sendMessage(text);
}

function md(text) {
  return DOMPurify.sanitize(marked.parse(text, { gfm: true, breaks: false }));
}

function toolLabel(name, input = {}) {
  if (name === 'audit_query') return `audit: ${Object.entries(input).filter(([k]) => k !== 'limit').map(([k, v]) => `${k}=${v}`).join(' ') || 'all'}`;
  const bits = [input.operation || input.type, input.object_type, input.object_name || input.name || input.search_term || input.query_name].filter(Boolean);
  return `${name.replace(/^bw_/, '')} ${bits.join(' ')}`;
}

async function sendMessage(text) {
  const log = $('#chat-log');
  log.querySelector('.intro')?.remove();
  $('#suggestions').innerHTML = '';
  log.insertAdjacentHTML('beforeend', `<div class="msg user">${esc(text)}</div>`);
  let block = null; // current assistant text block
  let buffer = '';
  let tools = null;
  let pending = false;
  const typing = document.createElement('div');
  typing.className = 'typing';
  typing.textContent = 'Claude is thinking…';
  log.append(typing);
  const scroll = () => { log.scrollTop = log.scrollHeight; };
  scroll();
  const flush = () => {
    pending = false;
    if (block) block.innerHTML = md(buffer);
    scroll();
  };

  state.chatBusy = true;
  setChatEnabled(true);
  $('#chat-stop').hidden = false;
  state.abort = new AbortController();
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: state.sessionId, message: text, target: state.target }),
      signal: state.abort.signal,
    });
    for await (const e of readSse(res)) {
      if (e.type === 'session') state.sessionId = e.id;
      else if (e.type === 'text') {
        if (!block) {
          block = document.createElement('div');
          block.className = 'msg assistant';
          log.insertBefore(block, typing);
          buffer = '';
          tools = null;
        }
        buffer += e.delta;
        if (!pending) { pending = true; requestAnimationFrame(flush); }
      } else if (e.type === 'tool_start') {
        if (block) flush();
        block = null;
        if (!tools) {
          tools = document.createElement('div');
          tools.className = 'tools';
          log.insertBefore(tools, typing);
        }
        tools.insertAdjacentHTML('beforeend', `<span class="tool" data-tool="${esc(e.id)}" title="${esc(JSON.stringify(e.input))}"><i class="spin"></i><span>${esc(toolLabel(e.name, e.input))}</span></span>`);
        typing.textContent = 'Reading BW…';
        scroll();
      } else if (e.type === 'tool_end') {
        const el = log.querySelector(`[data-tool="${CSS.escape(e.id)}"]`);
        if (el) { el.querySelector('.spin')?.remove(); el.classList.add(e.ok ? 'ok' : 'fail'); }
        typing.textContent = 'Claude is thinking…';
      } else if (e.type === 'error') {
        log.insertBefore(Object.assign(document.createElement('div'), { className: 'msg error', textContent: e.message }), typing);
      } else if (e.type === 'done') {
        if (e.stopReason === 'refusal') log.insertBefore(Object.assign(document.createElement('div'), { className: 'msg error', textContent: 'Claude declined to answer this request.' }), typing);
        if (e.stopReason === 'max_turns') log.insertBefore(Object.assign(document.createElement('div'), { className: 'msg notice', textContent: 'Stopped after many tool calls. Ask a narrower follow-up to continue.' }), typing);
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') log.insertBefore(Object.assign(document.createElement('div'), { className: 'msg error', textContent: `Chat failed: ${err.message}` }), typing);
  } finally {
    if (block) flush();
    typing.remove();
    state.chatBusy = false;
    state.abort = null;
    $('#chat-stop').hidden = true;
    setChatEnabled(state.chatEnabled);
    scroll();
  }
}

// ---------------------------------------------------------------- events

$$('.segmented button').forEach((b) => b.addEventListener('click', () => {
  state.scope = b.dataset.scope;
  $$('.segmented button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  state.filters.ids = null;
  render();
}));
$$('.tabs button').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
$('#f-search').addEventListener('input', (e) => { state.filters.search = e.target.value; renderObjects(); });
$('#f-category').addEventListener('change', (e) => { state.filters.category = e.target.value; renderObjects(); });
$('#f-type').addEventListener('change', (e) => { state.filters.type = e.target.value; renderObjects(); });
$('#f-min').addEventListener('change', (e) => { state.filters.min = Number(e.target.value); renderObjects(); });
$('#run-audit').addEventListener('click', runAudit);
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (state.audit) { renderCategoryChart(); renderDistributionChart(); } }, 150);
});

$('#chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#chat-input');
  const text = input.value.trim();
  if (!text || state.chatBusy || !state.chatEnabled) return;
  input.value = '';
  sendMessage(text);
});
$('#chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#chat-form').requestSubmit(); }
});
$('#chat-stop').addEventListener('click', () => state.abort?.abort());
$('#chat-new').addEventListener('click', async () => {
  state.abort?.abort();
  if (state.sessionId) await fetch('/api/chat/reset', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: state.sessionId }) });
  state.sessionId = null;
  $('#chat-log').innerHTML = '';
  renderChatIntro();
});
$('#chat-open').addEventListener('click', openChat);
$('#chat-close').addEventListener('click', () => $('#chat').classList.remove('open'));

load();
