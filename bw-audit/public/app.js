import { marked } from '/vendor/marked.js';
import DOMPurify from '/vendor/purify.js';
import { buildLineage, layoutLineage } from '/lineage.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = new Intl.NumberFormat('en');

const TYPE_LABEL = {
  ADSO: 'aDSO', ODSO: 'Classic DSO', CUBE: 'InfoCube', MPRO: 'MultiProvider', HCPR: 'CompositeProvider',
  TRFN: 'Transformation', DTPA: 'DTP', RSPC: 'Process chain', QUERY: 'Query', VARIABLE: 'Variable',
  AFO: 'AfO workbook', ALVL: 'Aggregation level', LSYS: 'Source system', IOBJ: 'Master data',
  UPDR: 'Update rules (3.x)', ISTS: 'Transfer rules (3.x)', ISFS: '3.x DataSource',
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
  domain: '',
  lineageZoom: 1,
  lineagePan: { x: 0, y: 0 },
  lineageAutoFit: true,
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

function inDomain(o) {
  return !state.domain || (o.domain || '~unassigned') === state.domain;
}

function inSelection(o) {
  return inScope(o) && inDomain(o);
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
    <label class="target-option" title="${esc(t.description)}">
      <input type="radio" name="target" value="${esc(t.key)}"${t.key === state.target ? ' checked' : ''}>
      <span>${esc(t.label)}</span>
    </label>`).join('');
  $$('#target-options input').forEach((r) => r.addEventListener('change', () => r.checked && setTarget(r.value)));
}

async function setTarget(key) {
  if (key === state.target) return;
  state.target = key;
  try { localStorage.setItem(TARGET_KEY, key); } catch { /* per-browser convenience only */ }
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
  $('#audit-line').hidden = !a;
  updateToc();
  if (!a) return;
  const sys = a.system;
  $('#system-line').textContent = [
    sys.logicalSystem, sys.platform, sys.software,
    sys.database,
  ].filter(Boolean).join(' · ');
  $('#audit-line').textContent = `audited ${new Date(a.generatedAt).toLocaleString()} · targeting ${a.target?.label || 'Generic platform'}`;
  renderKpis();
  renderDomainChart();
  renderDistributionChart();
  renderDomainFilter();
  renderArchitecture();
  renderDecommission();
  renderLineage();
  renderFindings();
  renderFilters();
  renderObjects();
  renderFlows();
  renderChains();
  renderSources();
  renderInventory();
  updateToc();
  $('#footnote').textContent = `Snapshot read in ${a.durationSec}s. ${a.errors.length ? `${a.errors.length} object(s) could not be read.` : 'Every object was read.'} ${a.target && a.target.key !== 'generic' ? `Scores come from fixed rules, adjusted for ${a.target.label}; each object lists the reasons.` : 'Scores come from fixed, platform-agnostic rules.'} Ask Agent to challenge any of them.`;
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

function domainLabel(key) {
  return state.audit.domains?.[key]?.label || key || '';
}

const clip = (text, n) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

function filterDomain(key) {
  state.domain = key;
  state.filters = { search: '', category: '', type: '', min: 1, ids: null, idsLabel: '' };
  state.expanded.clear();
  render();
}

function renderDomainFilter() {
  const allObjects = state.audit.objects;
  if (state.domain && !allObjects.some(inDomain)) state.domain = '';
  const scoped = allObjects.filter(inScope);
  const counts = new Map();
  for (const o of scoped) {
    const key = o.domain || '~unassigned';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  if (state.domain && !counts.has(state.domain)) counts.set(state.domain, 0);
  const domains = [...counts].map(([key, count]) => ({ key, count,
    label: domainLabel(key), special: state.audit.domains?.[key]?.special || key.startsWith('~'),
  })).sort((a, b) => Number(a.special) - Number(b.special) || b.count - a.count || a.label.localeCompare(b.label));
  $('#global-domains').innerHTML = [{ key: '', label: 'All domains', count: scoped.length }, ...domains].map((d) => `
    <button type="button" data-domain="${esc(d.key)}" aria-pressed="${d.key === state.domain}" class="${d.special ? 'special' : ''}" title="${esc(d.label)}">
      ${esc(d.label)} <span class="count">${fmt.format(d.count)}</span>
    </button>`).join('');
  $$('#global-domains button').forEach((b) => b.addEventListener('click', () => {
    filterDomain(b.dataset.domain);
    $$('#global-domains button').find((el) => el.dataset.domain === state.domain)?.focus({ preventScroll: true });
  }));
}

function renderDomainChart() {
  const el = $('#chart-domains');
  const doms = summary().byDomain;
  if (!doms) {
    el.innerHTML = '<p class="card-sub">This snapshot has no domain data yet. Run the audit again to group the objects by top-level InfoArea.</p>';
    return;
  }
  if (!doms.length) { el.innerHTML = '<p class="card-sub">No objects in scope.</p>'; return; }
  const W = Math.max(300, Math.round(el.clientWidth || 560));
  const labelW = W < 420 ? 128 : 190; const right = 78; const rowH = 30; const barH = 16; const top = 8;
  const maxChars = Math.floor((labelW - 14) / 6.6);
  const H = top + doms.length * rowH + 22;
  const x = (v) => labelW + ((W - labelW - right) * v) / 5;
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Average difficulty by domain">`;
  for (let t = 0; t <= 5; t++) {
    svg += `<line class="gridline" x1="${x(t)}" x2="${x(t)}" y1="${top - 4}" y2="${H - 20}"/>`;
    svg += `<text class="tick" x="${x(t)}" y="${H - 6}" text-anchor="middle">${t}</text>`;
  }
  svg += '<g class="bars">';
  doms.forEach((d, i) => {
    const y = top + i * rowH + (rowH - barH) / 2;
    svg += `<g class="bar-g" data-i="${i}">`;
    svg += `<text class="axis-label${d.special ? ' special' : ''}" x="${labelW - 10}" y="${y + barH / 2 + 4}" text-anchor="end">${esc(clip(d.label, maxChars))}</text>`;
    svg += `<path class="mark" d="${hbarPath(x(0), x(d.average), y, barH)}" fill="${d.special ? 'var(--bar-muted)' : 'var(--bar)'}"/>`;
    svg += `<text class="value-label" x="${x(d.average) + 8}" y="${y + barH / 2 + 4}">${d.average.toFixed(1)}</text>`;
    svg += `<text class="tick" x="${x(d.average) + 34}" y="${y + barH / 2 + 4}">${d.count} obj.</text>`;
    svg += `<rect class="hit" x="0" y="${top + i * rowH}" width="${W}" height="${rowH}"/>`;
    svg += '</g>';
  });
  svg += '</g></svg>';
  el.innerHTML = svg;
  wireHover(el, '.bar-g', (g) => {
    const d = doms[g.dataset.i];
    const areas = state.audit.domains?.[d.key]?.areas || [];
    return `<strong>${esc(d.label)}</strong>${d.special ? '' : `<span class="mono">${esc(d.key)}</span>${areas.length > 1 ? ` · ${areas.length} InfoAreas` : ''}<br>`}Average difficulty ${d.average.toFixed(1)}<br>${d.count} object(s), ${d.high} at 4 or 5`;
  }, (g) => {
    filterDomain(doms[g.dataset.i].key);
    $('#domain-filter-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

// ---------------------------------------------------------------- audited data flows

const LINEAGE_LABEL = { ...TYPE_LABEL, QUERY: 'BW query', RSDS: 'DataSource', TRCS: 'InfoSource', ISTD: '3.x InfoSource', PROV: 'InfoProvider' };
const lineageKind = (n) => n.type === 'QUERY' ? 'query' : ['TRFN', 'UPDR', 'ISTS'].includes(n.type) ? 'transformation'
  : ['RSDS', 'ISFS', 'TRCS', 'ISTD', 'IOBJ'].includes(n.type) ? 'source' : 'provider';

function renderLineage() {
  const label = state.domain ? domainLabel(state.domain) : 'All domains';
  const graph = layoutLineage(buildLineage(state.audit.objects, {
    domain: state.domain, includeSap: state.scope === 'all', flows: state.audit.flows || [],
  }));
  for (const n of graph.nodes) if (state.domain && n.context) n.inspectable = false;
  const audited = graph.nodes.filter((n) => !n.context).length;
  const context = graph.nodes.length - audited;
  $('#lineage-summary').textContent = `${label} · ${fmt.format(audited)} audited object(s) · ${fmt.format(graph.edges.length)} connection(s)${context ? ` · ${fmt.format(context)} upstream reference(s)` : ''}`;
  const connected = new Set(graph.edges.flatMap((e) => [e.from, e.to]));
  const unlinked = graph.nodes.filter((n) => !connected.has(n.id)).length;
  const feedback = graph.edges.some((e) => e.feedback);
  $('#lineage-note').textContent = graph.nodes.length
    ? `Arrows show recorded dependencies. Click and drag to move around; use + and − to zoom, or Fit to show all objects. Dashed boxes are upstream references.${unlinked ? ` ${unlinked} object(s) have no recorded connections in this snapshot.` : ''}${feedback ? ' Dashed arrows indicate cyclic dependencies.' : ''}`
    : 'No DataSources, transformations, providers or BW queries recorded for this domain in the selected scope.';
  const el = $('#lineage');
  el.innerHTML = graph.nodes.length ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${graph.width} ${graph.height}" data-width="${graph.width}" data-height="${graph.height}" role="group" aria-label="${esc(label)} data flows, flowing upward">
    <defs><marker id="lineage-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10Z"/></marker></defs>
    <g class="lineage-edges">${graph.edges.map((e) => `<path class="lineage-edge${e.feedback ? ' feedback' : ''}" d="${e.path}" marker-end="url(#lineage-arrow)"/>`).join('')}</g>
    ${graph.nodes.map((n, i) => {
      const type = LINEAGE_LABEL[n.type] || n.type;
      const title = `${type}: ${n.name}${n.description ? ` — ${n.description}` : ''}${n.sourceSystem ? ` · ${n.sourceSystem}` : ''}${n.context ? ` · upstream reference${n.domain ? ` (${domainLabel(n.domain)})` : ''}` : ''}`;
      return `<g class="lineage-node ${lineageKind(n)}${n.context ? ' context' : ''}${n.inspectable ? ' inspectable' : ''}" transform="translate(${n.x},${n.y})"${n.inspectable ? ` role="button" tabindex="0" data-node="${i}" aria-label="${esc(`Inspect ${title}`)}"` : ''}>
        <title>${esc(title)}</title>
        <rect class="lineage-box" width="${n.width}" height="${n.height}" rx="9"/>
        <rect class="lineage-accent" width="4" height="${n.height - 20}" x="1" y="10" rx="2"/>
        <text class="lineage-type" x="14" y="19">${esc(type)}${n.context ? ' · reference' : ''}</text>
        <text class="lineage-name" x="14" y="39">${esc(clip(n.name, 25))}</text>
        <text class="lineage-description" x="14" y="59">${esc(clip(n.sourceSystem || n.description || (n.details?.flow ? `${n.details.flow.source.name} → ${n.details.flow.target.name}` : 'No description'), 30))}</text>
      </g>`;
    }).join('')}
  </svg>` : '<p class="lineage-empty">No flow objects in this domain.</p>';
  $$('#lineage [data-node]').forEach((node) => {
    const inspect = async () => {
      const n = graph.nodes[node.dataset.node];
      if (isLineageFullscreen()) await exitLineageFullscreen();
      state.expanded.add(n.objectId);
      focusObjects([n.objectId], n.name);
    };
    node.addEventListener('click', inspect);
    node.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inspect(); } });
  });
  fitLineage();
}

function lineageFitZoom(svg) {
  const viewport = $('#lineage');
  return Math.min(1, Math.max(1, viewport.clientWidth - 24) / Number(svg.dataset.width),
    Math.max(1, viewport.clientHeight - 24) / Number(svg.dataset.height));
}

function fitLineage() {
  state.lineageAutoFit = true;
  const svg = $('#lineage svg');
  if (svg) {
    state.lineageZoom = lineageFitZoom(svg);
    state.lineagePan = {
      x: ($('#lineage').clientWidth - Number(svg.dataset.width) * state.lineageZoom) / 2,
      y: ($('#lineage').clientHeight - Number(svg.dataset.height) * state.lineageZoom) / 2,
    };
  }
  applyLineageZoom();
}

function applyLineageZoom() {
  const svg = $('#lineage svg');
  if (svg) {
    svg.style.width = `${Number(svg.dataset.width) * state.lineageZoom}px`;
    svg.style.height = `${Number(svg.dataset.height) * state.lineageZoom}px`;
    svg.style.transform = `translate(${state.lineagePan.x}px, ${state.lineagePan.y}px)`;
  }
  const percent = state.lineageZoom * 100;
  $('#lineage-zoom-reset').textContent = `Fit · ${percent < 10 ? percent.toFixed(1) : Math.round(percent)}%`;
  $('#lineage-zoom-out').disabled = !svg || state.lineageZoom <= Math.min(0.05, lineageFitZoom(svg));
  $('#lineage-zoom-in').disabled = !svg || state.lineageZoom >= 1.5;
  $('#lineage-zoom-reset').disabled = !svg;
}

function zoomLineage(factor) {
  const svg = $('#lineage svg');
  if (!svg) return;
  const zoom = Math.min(1.5, Math.max(Math.min(0.05, lineageFitZoom(svg)), state.lineageZoom * factor));
  const ratio = zoom / state.lineageZoom;
  const centerX = $('#lineage').clientWidth / 2; const centerY = $('#lineage').clientHeight / 2;
  state.lineagePan = { x: centerX - (centerX - state.lineagePan.x) * ratio,
    y: centerY - (centerY - state.lineagePan.y) * ratio };
  state.lineageZoom = zoom;
  state.lineageAutoFit = false;
  applyLineageZoom();
}

$('#lineage-zoom-out').addEventListener('click', () => zoomLineage(1 / 1.25));
$('#lineage-zoom-in').addEventListener('click', () => zoomLineage(1.25));
$('#lineage-zoom-reset').addEventListener('click', fitLineage);

function isLineageFullscreen() {
  return document.fullscreenElement === $('#lineage-card') || $('#lineage-card').classList.contains('lineage-fullscreen');
}

function updateLineageFullscreen() {
  const active = isLineageFullscreen();
  const button = $('#lineage-fullscreen');
  button.textContent = active ? 'Exit fullscreen' : 'Fullscreen';
  button.setAttribute('aria-pressed', String(active));
  button.setAttribute('aria-label', active ? 'Exit fullscreen' : 'Enter fullscreen');
  button.title = button.getAttribute('aria-label');
  fitLineage();
}

async function exitLineageFullscreen() {
  if (document.fullscreenElement === $('#lineage-card')) await document.exitFullscreen();
  $('#lineage-card').classList.remove('lineage-fullscreen');
  updateLineageFullscreen();
}

$('#lineage-fullscreen').addEventListener('click', async () => {
  if (isLineageFullscreen()) { await exitLineageFullscreen(); return; }
  const card = $('#lineage-card');
  try {
    if (!document.fullscreenEnabled || !card.requestFullscreen) throw new Error('Fullscreen unavailable');
    await card.requestFullscreen();
  } catch {
    // Expand within the window on browsers without the Fullscreen API.
    card.classList.add('lineage-fullscreen');
  }
  updateLineageFullscreen();
});
document.addEventListener('fullscreenchange', updateLineageFullscreen);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('#lineage-card').classList.contains('lineage-fullscreen')) {
    e.preventDefault();
    exitLineageFullscreen();
    $('#lineage-fullscreen').focus({ preventScroll: true });
  }
});

const lineageViewport = $('#lineage');
let lineageDrag = null;
let lineageDragged = false;
lineageViewport.addEventListener('pointerdown', (e) => {
  if (!e.isPrimary || e.button !== 0 || !$('#lineage svg')) return;
  lineageDragged = false;
  lineageDrag = { id: e.pointerId, startX: e.clientX, startY: e.clientY, pan: { ...state.lineagePan } };
});
lineageViewport.addEventListener('pointermove', (e) => {
  if (!lineageDrag || e.pointerId !== lineageDrag.id) return;
  const dx = e.clientX - lineageDrag.startX; const dy = e.clientY - lineageDrag.startY;
  if (!lineageDragged && Math.hypot(dx, dy) < 4) return;
  if (!lineageDragged) {
    lineageDragged = true;
    lineageViewport.setPointerCapture(e.pointerId);
    lineageViewport.classList.add('is-panning');
    state.lineageAutoFit = false;
  }
  state.lineagePan = { x: lineageDrag.pan.x + dx, y: lineageDrag.pan.y + dy };
  applyLineageZoom();
});
function endLineageDrag(e) {
  if (!lineageDrag || e.pointerId !== lineageDrag.id) return;
  lineageDrag = null;
  lineageViewport.classList.remove('is-panning');
  if (lineageViewport.hasPointerCapture(e.pointerId)) lineageViewport.releasePointerCapture(e.pointerId);
}
window.addEventListener('pointerup', endLineageDrag);
for (const event of ['pointercancel', 'lostpointercapture']) lineageViewport.addEventListener(event, endLineageDrag);
// A drag beginning on an object must not open its details when released.
lineageViewport.addEventListener('click', (e) => {
  if (lineageDragged && e.detail > 0) { e.preventDefault(); e.stopImmediatePropagation(); }
}, true);
lineageViewport.addEventListener('keydown', (e) => {
  if (e.target !== lineageViewport || !$('#lineage svg')) return;
  const delta = { ArrowLeft: [40, 0], ArrowRight: [-40, 0], ArrowUp: [0, 40], ArrowDown: [0, -40] }[e.key];
  if (!delta) return;
  e.preventDefault();
  state.lineageAutoFit = false;
  state.lineagePan.x += delta[0]; state.lineagePan.y += delta[1];
  applyLineageZoom();
});
new ResizeObserver(() => {
  if (state.lineageAutoFit && $('#lineage svg')) fitLineage();
}).observe(lineageViewport);

// ---------------------------------------------------------------- target architecture

function typePlural(type, n) {
  const label = TYPE_LABEL[type] || type;
  if (n === 1 || type === 'IOBJ') return label;
  return label.endsWith('y') ? `${label.slice(0, -1)}ies` : `${label}s`;
}

const LAYER_ICON ={ ingest: '⇣', integration: '⚙', masterdata: '◇', marts: '▦', semantic: '◔', planning: '✎', orchestration: '↻' };

function renderArchitecture() {
  const card = $('#architecture-card');
  const arch = state.audit.architecture;
  card.hidden = !arch;
  if (!arch) return;
  const doms = arch[state.scope === 'all' ? 'all' : 'custom'].filter((d) => !state.domain || d.key === state.domain);
  $('#architecture-title').textContent = `Target architecture on ${arch.target.label}`;
  $('#architecture-sub').textContent = 'One proposal per domain: where each BW object lands on the target. Click a layer\'s objects to list them below.';
  if (!doms.length) { $('#architecture').innerHTML = '<p class="card-sub">No objects in this domain and scope.</p>'; return; }
  $('#architecture').innerHTML = doms.map((d, i) => `
    <article class="architecture-domain" data-architecture-domain="${i}">
    <div class="arch-head">
      <div>
        <h3>${esc(d.label)}${d.special ? '' : ` <span class="mono key">${esc(d.key)}</span>`}</h3>
        <p>${esc(d.container)}</p>
      </div>
      <div class="arch-stats">
        <span>${difficultyCell(Math.round(d.average))}</span>
        <span class="card-sub">${d.count} object(s), average ${d.average.toFixed(1)}</span>
        <div class="arch-actions">
          <button class="btn small" data-arch-list>List objects</button>
          <button class="btn small primary" data-arch-ask>Ask Agent</button>
        </div>
      </div>
    </div>
    <ol class="arch-layers">${d.layers.map((l, i) => `
      <li class="arch-layer" data-layer="${esc(l.key)}">
        <div class="arch-layer-name"><span class="ico" aria-hidden="true">${LAYER_ICON[l.key] || '•'}</span>${esc(l.label)}</div>
        <div class="arch-layer-body">
          <strong>${esc(l.component)}</strong>
          ${l.detail ? `<p>${esc(l.detail)}</p>` : ''}
        </div>
        <div class="arch-layer-from">
          <span class="from-label">from BW</span>
          <button class="chip" data-layer-i="${i}" title="List these objects">${l.types.map((t) => `${t.count} ${esc(typePlural(t.type, t.count))}`).join(' · ')}</button>
        </div>
      </li>`).join('')}
    </ol>
    ${d.notes.length ? `<ul class="arch-notes">${d.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
    </article>`).join('');
  const domainOf = (b) => doms[b.closest('[data-architecture-domain]').dataset.architectureDomain];
  $$('#architecture [data-layer-i]').forEach((b) => b.addEventListener('click', () => {
    const d = domainOf(b);
    const l = d.layers[b.dataset.layerI];
    focusObjects(l.ids, `${d.label} · ${l.label}`);
  }));
  $$('#architecture [data-arch-list]').forEach((b) => b.addEventListener('click', () => {
    const d = domainOf(b);
    focusObjects(state.audit.objects.filter((o) => inScope(o) && (o.domain || '~unassigned') === d.key).map((o) => o.id), d.label);
  }));
  $$('#architecture [data-arch-ask]').forEach((b) => b.addEventListener('click', () => {
    const d = domainOf(b);
    askClaude(`Domain "${d.label}" (${d.special ? d.key : `top-level InfoArea ${d.key}`}, ${d.count} object(s)). The audit proposes this target architecture on ${arch.target.label}: ${d.container} ${d.layers.map((l) => `${l.label}: ${l.component} (${l.types.map((t) => `${t.count} ${t.type}`).join(', ')})`).join('; ')}. Check it against the objects of the domain in BW, challenge it, and propose the migration waves for this domain.`);
  }));
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
    const objs = f.objects.map((id) => byId.get(id)).filter((o) => o && inSelection(o));
    return { ...f, inScope: objs };
  }).filter((f) => f.inScope.length || (!state.domain && f.objects.length === 0));
  $('#findings').innerHTML = items.length ? items.map((f, i) => `
    <li class="finding">
      ${statusBadge(f.severity)}
      <div>
        <h3>${esc(f.title)}${f.inScope.length ? ` · ${f.inScope.length}` : ''}</h3>
        <p>${esc(f.detail)}</p>
        ${f.inScope.length ? `<div class="objs">${f.inScope.slice(0, 10).map((o) => `<button class="chip" data-obj="${esc(o.id)}" title="${esc(o.description || '')}">${esc(shortName(o))}</button>`).join('')}${f.inScope.length > 10 ? `<button class="chip" data-finding="${i}">+${f.inScope.length - 10} more</button>` : ''}</div>` : ''}
      </div>
      ${f.inScope.length ? `<button class="btn small" data-ask-finding="${i}">Ask Agent</button>` : '<span></span>'}
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

// ---------------------------------------------------------------- decommission candidates

const DECOM_FLAGS = ['never loaded', 'never run', 'inactive'];
const isDecom = (o) => o.flags.some((f) => DECOM_FLAGS.includes(f));
const flowText = (f) => (f ? `${f.source.type} ${f.source.name} → ${f.target.type} ${f.target.name}` : '');
const sameFlow = (a, b) => a && b && a.source.name === b.source.name && a.target.type === b.target.type
  && (a.target.name.startsWith(b.target.name) || b.target.name.startsWith(a.target.name));

/** Why an object is a candidate, and what to check before dropping it, from the snapshot. */
function decomEvidence(o) {
  const objs = state.audit.objects;
  const why = [];
  const check = [];
  const d = o.details || {};
  if (o.flags.includes('inactive')) {
    const what = {
      TRFN: 'it cannot be executed', DTPA: 'it cannot load', HCPR: 'queries cannot run on it', ADSO: 'it cannot be loaded or reported on',
      QUERY: 'it cannot be executed', RSPC: 'it cannot be scheduled',
    }[o.type] || 'it cannot be used';
    why.push(`Inactive: never activated, or changed and not re-activated, so ${what}.`);
    if (o.type === 'TRFN' || o.type === 'DTPA') {
      const active = objs.filter((x) => x.type === o.type && x.id !== o.id && x.status === 'active' && sameFlow(x.details?.flow, d.flow));
      if (active.length) why.push(`Superseded: ${active.length === 1 ? `an active ${TYPE_LABEL[o.type]}` : `${active.length} active ${TYPE_LABEL[o.type]}s`} cover${active.length === 1 ? 's' : ''} the same flow (${active.map((x) => x.name).join(', ')}).`);
      else check.push('No active version covers this flow: confirm the flow itself is no longer needed.');
    }
  }
  if (o.flags.includes('never loaded')) {
    why.push('No load request in its history (never loaded, or the requests have been deleted).');
  }
  if (o.flags.includes('never run')) {
    why.push('No run in the process chain log.');
    const loads = (d.steps || []).filter((st) => st.processType === 'DTP_LOAD').length;
    if (loads) check.push(`It has ${loads} DTP load step(s): check whether the loads run another way (manually or from another chain).`);
  }
  // Dependencies that would break, or confirm, the removal.
  if (o.type === 'DTPA') {
    const chains = objs.filter((c) => c.type === 'RSPC' && (c.details?.steps || []).some((st) => st.variant === o.name));
    if (chains.length) check.push(`Step of process chain ${chains.map((c) => c.name).join(', ')}: remove it from the chain too.`);
  }
  if (['HCPR', 'CUBE', 'ODSO', 'MPRO', 'ADSO'].includes(o.type)) {
    const queries = objs.filter((q) => q.type === 'QUERY' && q.details?.provider === o.name);
    if (queries.length) check.push(`${queries.length} query/queries defined on it (${queries.slice(0, 3).map((q) => q.name).join(', ')}${queries.length > 3 ? ', …' : ''}).`);
    const users = objs.filter((m) => (m.type === 'MPRO' && (m.details?.parts || []).some((p) => p.name === o.name))
      || (m.type === 'HCPR' && (m.details?.inputProviders || []).some((p) => p.split(' ')[1] === o.name)));
    if (users.length) check.push(`Part of ${users.map((m) => `${TYPE_LABEL[m.type]} ${m.name}`).join(', ')}.`);
    const feeds = objs.filter((t) => t.type === 'TRFN' && t.status === 'active' && t.details?.flow?.target?.name === o.name);
    if (feeds.length) check.push(`${feeds.length} active transformation(s) still load it.`);
  }
  return { why, check };
}

function decomCandidates() {
  return state.audit.objects.filter((o) => o.difficulty && inSelection(o) && isDecom(o))
    .sort((a, b) => domainLabel(a.domain).localeCompare(domainLabel(b.domain)) || a.type.localeCompare(b.type) || shortName(a).localeCompare(shortName(b)));
}

function renderDecommission() {
  const list = decomCandidates();
  $('#decom-title').textContent = `Decommission candidates · ${fmt.format(list.length)}`;
  $('#decom-list').disabled = !list.length;
  $('#decom-ask').disabled = !list.length;
  if (!list.length) {
    $('#decom-table').innerHTML = '<tbody><tr><td>No decommission candidates in this scope.</td></tr></tbody>';
    $('#decom-note').textContent = '';
    return;
  }
  const showOrigin = state.scope === 'all';
  const rows = list.map((o) => ({ o, e: decomEvidence(o) }));
  $('#decom-table').innerHTML = `<thead><tr><th>Object</th><th>Domain</th><th>Why it is a candidate</th><th>Check before removing</th>${showOrigin ? '<th>Origin</th>' : ''}</tr></thead><tbody>${
    rows.map(({ o, e }) => {
      const desc = (o.type === 'TRFN' || o.type === 'DTPA') ? (flowText(o.details.flow) || o.description) : o.description;
      return `<tr class="row" data-id="${esc(o.id)}" title="Show in the objects table">
        <td class="decom-obj">
          <div>${esc(TYPE_LABEL[o.type] || o.type)} ${o.flags.filter((f) => DECOM_FLAGS.includes(f)).map((f) => `<span class="flag">${esc(f)}</span>`).join('')}</div>
          <div class="mono">${esc(o.name)}</div>
          ${desc ? `<div class="desc">${esc(desc)}</div>` : ''}
        </td>
        <td title="${esc(o.domainVia || '')}">${esc(domainLabel(o.domain))}</td>
        <td><ul class="evidence">${e.why.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></td>
        <td>${e.check.length ? `<ul class="evidence check">${e.check.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : '<span class="muted">No dependency found in the audit</span>'}</td>
        ${showOrigin ? `<td>${o.origin === 'sap' ? 'SAP content' : 'Customer'}</td>` : ''}
      </tr>`;
    }).join('')}</tbody>`;
  const blocked = rows.filter((r) => r.e.check.length).length;
  $('#decom-note').textContent = `${fmt.format(list.length - blocked)} with no dependency found in the audit, ${fmt.format(blocked)} with something to check first. Click a row for its score and details.`;
  $$('#decom-table tr.row').forEach((r) => r.addEventListener('click', () => { state.expanded.add(r.dataset.id); focusObjects([r.dataset.id], r.querySelector('.mono').textContent); }));
}

$('#decom-list').addEventListener('click', () => focusObjects(decomCandidates().map((o) => o.id), 'Decommission candidates'));
$('#decom-ask').addEventListener('click', () => {
  const list = decomCandidates();
  askClaude(`Decommission candidates (${list.length}): ${list.slice(0, 30).map((o) => `${o.type} ${o.name} [${o.flags.filter((f) => DECOM_FLAGS.includes(f)).join(', ')}]`).join('; ')}${list.length > 30 ? '; …' : ''}. Check each in BW (where-used, last changes, load history) and tell me which can safely be left out of the migration and which need a decision from the business.`);
});

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
  const objs = state.audit.objects.filter((o) => o.difficulty && inSelection(o));
  const cats = state.audit.categories;
  $('#f-category').innerHTML = '<option value="">All areas</option>' + Object.entries(cats)
    .map(([k, v]) => `<option value="${k}"${state.filters.category === k ? ' selected' : ''}>${esc(v.label)}</option>`).join('');
  const types = [...new Set(objs.map((o) => o.type))].sort();
  if (!types.includes(state.filters.type)) state.filters.type = '';
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
  let list = state.audit.objects.filter((o) => o.difficulty && inSelection(o));
  if (f.ids) list = list.filter((o) => f.ids.has(o.id));
  if (f.category) list = list.filter((o) => o.category === f.category);
  if (f.type) list = list.filter((o) => o.type === f.type);
  if (f.min > 1) list = list.filter((o) => o.difficulty >= f.min);
  if (q) list = list.filter((o) => `${o.name} ${o.description} ${shortName(o)}`.toLowerCase().includes(q));
  const { key, dir } = state.sort;
  const val = (o) => key === 'name' ? shortName(o).toLowerCase() : key === 'type' ? o.type : key === 'category' ? o.category : key === 'domain' ? domainLabel(o.domain).toLowerCase() : o.difficulty;
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
  const cols = showOrigin ? 8 : 7;
  let html = `<thead><tr>${th('difficulty', 'Difficulty')}${th('type', 'Type')}${th('name', 'Name')}<th>Description</th>${th('domain', 'Domain')}${th('category', 'Area')}<th>Flags</th>${showOrigin ? '<th>Origin</th>' : ''}</tr></thead><tbody>`;
  for (const o of list.slice(0, OBJECT_LIMIT)) {
    const open = state.expanded.has(o.id);
    html += `<tr class="row${open ? ' expanded' : ''}" data-id="${esc(o.id)}" aria-expanded="${open}">
      <td>${difficultyCell(o.difficulty)}</td>
      <td>${esc(TYPE_LABEL[o.type] || o.type)}</td>
      <td class="mono">${esc(shortName(o))}</td>
      <td>${esc(o.type === 'TRFN' ? o.name : o.description)}</td>
      <td title="${esc(o.domainVia || '')}">${esc(domainLabel(o.domain))}</td>
      <td>${esc(cats[o.category]?.label || '')}</td>
      <td>${o.flags.map((f) => `<span class="flag">${esc(f)}</span>`).join('')}</td>
      ${showOrigin ? `<td>${o.origin === 'sap' ? 'SAP content' : 'Customer'}</td>` : ''}
    </tr>`;
    if (open) html += `<tr class="detail-row"><td colspan="${cols}">${objectDetail(o)}</td></tr>`;
  }
  if (!list.length) html += `<tr><td colspan="${cols}">No objects match the selected domain, scope and table filters.</td></tr>`;
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
  } else if (o.type === 'IOBJ') {
    add('InfoArea', d.infoArea); add('Attributes', d.attributes);
    add('Time-dependent', d.timeDependent ? 'yes' : null); add('Hierarchies', d.hierarchies ? 'yes' : null);
    add('Used in providers', Object.entries(d.usage || {}).map(([k, n]) => `${domainLabel(k)} ${n}`));
    const loads = state.audit.flows.filter((f) => f.target.type === 'IOBJ' && o.name.startsWith(f.target.name)).length;
    add('Loading transformations', loads || null);
  } else if (o.type === 'ALVL') {
    add('InfoProvider', d.provider); add('InfoArea', d.infoArea);
  }
  if (o.domain) add('Domain', `${domainLabel(o.domain)}${o.domainVia ? `, ${o.domainVia}` : ''}`);
  return `<div><strong>Why ${o.difficulty}/5</strong><ul>${o.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
    ${kv.length ? `<div class="kv">${kv.join(' · ')}</div>` : ''}
    <div style="margin-top:10px"><button class="btn small primary" data-ask="${esc(o.id)}">Ask Agent about this object</button></div></div>`;
}

function renderFlows() {
  const transformations = new Set(state.audit.objects.filter((o) => o.type === 'TRFN' && inSelection(o)).map((o) => o.name));
  const flows = state.audit.flows.filter((f) => inScope(f) && (!state.domain || transformations.has(f.transformation)))
    .sort((a, b) => b.difficulty - a.difficulty || a.target.name.localeCompare(b.target.name));
  $('#flows-table').innerHTML = `<thead><tr><th>Difficulty</th><th>Source</th><th>Target</th><th>Routines</th><th class="num">ABAP lines</th><th>DTPs</th><th>Status</th></tr></thead><tbody>${
    flows.map((f) => `<tr class="row" data-id="TRFN:${esc(f.transformation)}">
      <td>${difficultyCell(f.difficulty)}</td>
      <td class="mono">${esc(f.source.type)} ${esc(f.source.name)}${f.source.sourceSystem ? ` <span class="flag">${esc(f.source.sourceSystem)}</span>` : ''}</td>
      <td class="mono">${esc(f.target.type)} ${esc(f.target.name)}</td>
      <td>${f.routines.length ? f.routines.map((r) => `<span class="flag">${esc(r)}</span>`).join('') : '–'}</td>
      <td class="num">${f.abapLines || '–'}</td>
      <td>${f.dtps.length ? f.dtps.map((d) => `<span class="flag" title="${esc(d.name)}">${esc(d.status)}</span>`).join('') : '–'}</td>
      <td>${esc(f.status)}</td></tr>`).join('') || '<tr><td colspan="7">No data flows in this domain and scope.</td></tr>'}</tbody>`;
  $$('#flows-table tr.row').forEach((r) => r.addEventListener('click', () => { state.expanded.add(r.dataset.id); focusObjects([r.dataset.id], r.dataset.id.slice(5)); }));
}

function chainStatus(run) {
  if (!run) return statusBadge('none', 'no run data');
  const sev = run.color === 'green' ? 'good' : run.color === 'red' ? 'critical' : run.color === 'yellow' ? 'warning' : 'none';
  return `<span class="status ${sev}"><span class="ico" aria-hidden="true">${sev === 'good' ? '✓' : sev === 'none' ? '–' : '!'}</span>${esc(run.statusText)}</span>`;
}

function renderChains() {
  const chains = state.audit.objects.filter((o) => o.type === 'RSPC' && inSelection(o));
  $('#chains-table').innerHTML = `<thead><tr><th>Last run</th><th>Chain</th><th>Description</th><th>Started</th><th>Steps</th><th>Difficulty</th></tr></thead><tbody>${
    chains.map((c) => `<tr class="row" data-id="${esc(c.id)}">
      <td>${chainStatus(c.details.lastRun)}</td>
      <td class="mono">${esc(c.name)}</td>
      <td>${esc(c.description)}</td>
      <td>${esc(c.details.lastRun?.lastStart || '–')}</td>
      <td>${(c.details.steps || []).map((s) => `<span class="flag">${esc(s.processType)}</span>`).join('')}</td>
      <td>${difficultyCell(c.difficulty)}</td></tr>`).join('') || '<tr><td colspan="6">No process chains in this domain and scope.</td></tr>'}</tbody>`;
  $$('#chains-table tr.row').forEach((r) => r.addEventListener('click', () => { state.expanded.add(r.dataset.id); focusObjects([r.dataset.id], r.dataset.id.slice(5)); }));
}

function renderSources() {
  const src = state.audit.objects.filter((o) => o.type === 'LSYS' && inSelection(o));
  $('#sources-table').innerHTML = `<thead><tr><th>Source system</th><th>Description</th><th>Type</th><th>Difficulty</th><th>Why</th></tr></thead><tbody>${
    src.map((s) => `<tr><td class="mono">${esc(s.name)}</td><td>${esc(s.description)}</td><td class="mono">${esc(s.details.sourceSystemType)}</td><td>${difficultyCell(s.difficulty)}</td><td>${esc(s.reasons.join('; '))}</td></tr>`).join('') || '<tr><td colspan="5">No source systems assigned to this domain and scope.</td></tr>'}</tbody>`;
}

function renderInventory() {
  let inventory = state.audit.inventory;
  if (state.domain) {
    inventory = {};
    for (const o of state.audit.objects.filter(inSelection)) {
      const type = o.type === 'IOBJ' ? 'IOBJ_MD' : o.type;
      const item = inventory[type] ||= { label: state.audit.inventory[type]?.label || TYPE_LABEL[o.type] || o.type,
        total: 0, custom: 0, sap: 0, inactive: 0 };
      item.total++;
      item[o.origin === 'sap' ? 'sap' : 'custom']++;
      if (o.status && o.status !== 'active') item.inactive++;
    }
  }
  const inv = Object.entries(inventory).sort((a, b) => b[1].total - a[1].total);
  $('#inventory-table').innerHTML = `<thead><tr><th>Object type</th><th class="num">Total</th><th class="num">Customer</th><th class="num">SAP content</th><th class="num">Inactive</th></tr></thead><tbody>${
    inv.map(([k, v]) => `<tr><td>${esc(v.label)} <span class="flag">${esc(k)}</span></td><td class="num">${fmt.format(v.total)}</td><td class="num">${fmt.format(v.custom)}</td><td class="num">${fmt.format(v.sap)}</td><td class="num">${fmt.format(v.inactive)}</td></tr>`).join('') || '<tr><td colspan="5">No audited objects in this domain and scope.</td></tr>'}</tbody>`;
  $('#inventory-note').textContent = state.domain ? 'Domain counts cover audited objects with domain assignments. Object types counted only system-wide are not included.' : 'System-wide inventory, including SAP content.';
}

function switchTab(tab) {
  state.tab = tab;
  $$('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  $$('.tab-panel').forEach((p) => { p.hidden = p.dataset.panel !== tab; });
  spyToc();
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

// ---------------------------------------------------------------- table of contents

// highlights the section that crosses the upper third of the page; at the bottom, the last one
function spyToc() {
  if (!state.audit) return;
  const main = $('#main');
  const links = $$('.toc [data-toc]').filter((l) => !l.parentElement.hidden);
  const line = main.getBoundingClientRect().top + main.clientHeight / 3;
  const atBottom = main.scrollTop + main.clientHeight >= main.scrollHeight - 4;
  let current = links[0];
  for (const l of links) if (atBottom || $('#' + l.dataset.toc).getBoundingClientRect().top <= line) current = l;
  links.forEach((l) => l.classList.toggle('active', l === current));
  // the selected tab is highlighted only while the Details section is the one being read
  const inDetails = current?.dataset.toc === 'details-card';
  $$('.toc [data-toc-tab]').forEach((l) => l.classList.toggle('active', inDetails && l.dataset.tocTab === state.tab));
}

let spyPending = false;
$('#main').addEventListener('scroll', () => {
  if (spyPending) return;
  spyPending = true;
  requestAnimationFrame(() => { spyPending = false; spyToc(); });
}, { passive: true });

function updateToc() {
  const show = Boolean(state.audit);
  $('#toc-sections').hidden = !show;
  if (!show) return;
  $$('.toc [data-toc]').forEach((l) => { l.parentElement.hidden = $('#' + l.dataset.toc).hidden; });
  spyToc();
}

$('#toc').addEventListener('click', (e) => {
  const link = e.target.closest('a');
  if (!link) return;
  e.preventDefault();
  if (link.dataset.tocTab) switchTab(link.dataset.tocTab);
  const target = $(link.getAttribute('href'));
  target?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  history.replaceState(null, '', link.getAttribute('href'));
});

// ---------------------------------------------------------------- chat panel

const CHAT_FOLD_KEY = 'bw-audit-chat-folded';
const overlayChat = matchMedia('(max-width: 1100px)');

function setChatFolded(folded) {
  $('#layout').classList.toggle('chat-folded', folded);
  try { localStorage.setItem(CHAT_FOLD_KEY, folded ? '1' : '0'); } catch { /* storage unavailable */ }
  // charts are sized to their container: redraw once the new column widths apply
  requestAnimationFrame(() => { if (state.audit) { renderDomainChart(); renderDistributionChart(); } });
}

try { if (localStorage.getItem(CHAT_FOLD_KEY) === '1') $('#layout').classList.add('chat-folded'); } catch { /* storage unavailable */ }

// ---------------------------------------------------------------- sections panel

const TOC_FOLD_KEY = 'bw-audit-toc-folded';

function setTocFolded(folded, persist = true) {
  $('#layout').classList.toggle('toc-folded', folded);
  const btn = $('#toc-toggle');
  btn.textContent = folded ? '❯' : '❮';
  btn.setAttribute('aria-expanded', String(!folded));
  btn.title = btn.ariaLabel = folded ? 'Show sections panel' : 'Fold sections panel';
  if (!persist) return;
  try { localStorage.setItem(TOC_FOLD_KEY, folded ? '1' : '0'); } catch { /* storage unavailable */ }
  requestAnimationFrame(() => { if (state.audit) { renderDomainChart(); renderDistributionChart(); } });
}

try { if (localStorage.getItem(TOC_FOLD_KEY) === '1') setTocFolded(true, false); } catch { /* storage unavailable */ }

function openChat() {
  if (overlayChat.matches) $('#chat').classList.add('open');
  else if ($('#layout').classList.contains('chat-folded')) setChatFolded(false);
  $('#chat-input').focus();
}

function closeChat() {
  if (overlayChat.matches) $('#chat').classList.toggle('open', false);
  else setChatFolded(true);
}

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
  resizeTimer = setTimeout(() => { if (state.audit) { renderDomainChart(); renderDistributionChart(); } }, 150);
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
$('#chat-close').addEventListener('click', closeChat);
$('#toc-toggle').addEventListener('click', () => setTocFolded(!$('#layout').classList.contains('toc-folded')));

load();
