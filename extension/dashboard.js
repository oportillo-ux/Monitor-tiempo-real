// Tablero consolidado: lee los cortes que guardó content.js y se redibuja solo
// cada vez que llega un corte nuevo de cualquier estación.
const STALE_MS = 20 * 60 * 1000;
const pct = (a, b) => (b > 0 ? (a / b) * 100 : null);
const fmt = (v) => (v == null ? '—' : v.toFixed(1) + '%');
const color = (v) => (v == null ? 'var(--muted)' : v >= 75 ? 'var(--good)' : v >= 40 ? 'var(--mid)' : 'var(--bad)');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const track = (v) => `<div class="track"><span style="width:${Math.min(100, v || 0)}%;background:${color(v)}"></span></div>`;
const hhmm = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const $ = (id) => document.getElementById(id);
let data = { snaps: [], prevs: {}, hists: {} };

try {
  $('sort').value = localStorage.getItem('bdb-sort') || 'stops';
} catch {}

async function load() {
  const { stations = [] } = await chrome.storage.local.get('stations');
  const keys = stations.flatMap((s) => ['snap:' + s, 'prev:' + s, 'hist:' + s]);
  const got = keys.length ? await chrome.storage.local.get(keys) : {};
  data = { snaps: [], prevs: {}, hists: {} };
  for (const s of stations) {
    if (got['snap:' + s]) data.snaps.push(got['snap:' + s]);
    data.prevs[s] = got['prev:' + s] || null;
    data.hists[s] = got['hist:' + s] || [];
  }
  data.snaps.sort((a, b) => a.station.localeCompare(b.station));
  render();
}

// Variación del % de la estación frente al registro de hace ~15 min.
function trend(station, key) {
  const h = data.hists[station];
  if (!h || h.length < 2) return '';
  const cur = h[h.length - 1];
  const ref = [...h].reverse().find((x) => cur.ts - x.ts >= 10 * 60 * 1000);
  if (!ref || cur[key] == null || ref[key] == null) return '';
  const d = cur[key] - ref[key];
  return `<small>${d >= 0 ? '▲' : '▼'} ${Math.abs(d).toFixed(1)} pts</small>`;
}

function render() {
  const now = Date.now();
  $('empty').hidden = data.snaps.length > 0;
  $('meta').textContent = data.snaps.length
    ? `${data.snaps.length} estación(es) · se actualiza cada 15 min · visto ${hhmm(now)}`
    : '';

  $('stations').innerHTML = data.snaps.map((s) => {
    const t = s.totals;
    const stale = now - s.ts > STALE_MS;
    return `<div class="card">
      <h3>${esc(s.station)} <span class="ts ${stale ? 'stale' : ''}" title="${stale ? 'Sin corte reciente: revisa que la pestaña del portal siga abierta y con sesión' : ''}">corte ${hhmm(s.ts)}</span></h3>
      <div class="kpi"><div class="top"><label>Paradas</label><span><b style="color:${color(t.stopsPct)}">${fmt(t.stopsPct)}</b>${trend(s.station, 'stopsPct')}</span></div>
        ${track(t.stopsPct)}<div class="sub" style="font-size:11px;color:var(--muted)">${t.stopsDone} de ${t.stopsTotal}</div></div>
      <div class="kpi"><div class="top"><label>Entregas</label><span><b style="color:${color(t.delPct)}">${fmt(t.delPct)}</b>${trend(s.station, 'delPct')}</span></div>
        ${track(t.delPct)}<div class="sub" style="font-size:11px;color:var(--muted)">${t.delDone} de ${t.delTotal}</div></div>
      <div class="foot">${t.routes} rutas · ${t.notDeparted} sin salir</div>
    </div>`;
  }).join('');

  const q = $('filter').value.trim().toLowerCase();
  const sort = $('sort').value;
  const rows = data.snaps.flatMap((s) => {
    const prevBy = new Map((data.prevs[s.station]?.routes || []).map((r) => [r.route, r]));
    return s.routes.map((r) => ({ ...r, station: s.station, prev: prevBy.get(r.route) }));
  }).filter((r) => !q || `${r.station} ${r.route} ${r.drivers.join(' ')}`.toLowerCase().includes(q));

  const key = sort === 'del' ? (r) => pct(r.delDone, r.delTotal) ?? -1 : (r) => pct(r.stopsDone, r.stopsTotal) ?? -1;
  rows.sort(sort === 'route'
    ? (a, b) => a.station.localeCompare(b.station) || a.route.localeCompare(b.route, undefined, { numeric: true })
    : (a, b) => key(a) - key(b));

  $('rows').innerHTML = rows.map((r) => {
    const sp = pct(r.stopsDone, r.stopsTotal), dp = pct(r.delDone, r.delTotal);
    const delta = r.prev ? r.stopsDone - r.prev.stopsDone : null;
    return `<tr>
      <td>${esc(r.station)}</td>
      <td><b>${esc(r.route)}</b></td>
      <td>${esc(r.drivers.join(' / ') || '—')}</td>
      <td class="status">${r.notDeparted ? '<span class="tag">Sin salir</span> ' : ''}${esc(r.status.replace(/not departed\s*\|?/i, ''))}</td>
      <td><b style="color:${color(sp)}">${fmt(sp)}</b> <span class="sub">${r.stopsDone}/${r.stopsTotal}</span>${track(sp)}</td>
      <td><b style="color:${color(dp)}">${fmt(dp)}</b> <span class="sub">${r.delDone}/${r.delTotal}</span>${track(dp)}</td>
      <td>${delta == null ? '—' : (delta > 0 ? '+' : '') + delta}</td>
    </tr>`;
  }).join('');
}

$('filter').addEventListener('input', render);
$('sort').addEventListener('change', () => {
  try { localStorage.setItem('bdb-sort', $('sort').value); } catch {}
  render();
});
$('refresh').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'refreshAll' }));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && Object.keys(changes).some((k) => k.startsWith('snap:') || k === 'stations')) load();
});
setInterval(render, 60 * 1000); // mantiene al día el aviso de "corte viejo"
load();
