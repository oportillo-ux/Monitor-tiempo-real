// Corre dentro del portal: espera a que carguen las rutas, las lee (incluso si la
// lista es virtual y hay que hacer scroll), guarda el corte y muestra el panel.
(() => {
  if (window.__bdbMonitor) return;
  window.__bdbMonitor = true;

  const { parsePage, findRows } = globalThis.BDBParser;
  const STATION_RE = /^[A-Z]{3}\d{1,2}$/;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- Estación ----------
  function detectStation() {
    try {
      const o = sessionStorage.getItem('bdb-station');
      if (o) return o;
    } catch {}
    // Código tipo "DMX4" visible en selectores o encabezados del portal.
    const rows = findRows();
    const candidates = document.querySelectorAll('select option:checked, button, [role="combobox"], [role="button"], header *, h1, h2, h3, span, div');
    for (const el of candidates) {
      if (el.closest('#bdb-monitor-host') || el.children.length > 1) continue;
      if (rows.some((r) => r.contains(el))) continue;
      const t = (el.textContent || '').trim();
      if (STATION_RE.test(t)) return t;
      const m = t.match(/^([A-Z]{3}\d{1,2})\b/);
      if (m && t.length < 40) return m[1];
    }
    const p = new URLSearchParams(location.search + '&' + location.hash.replace(/^#/, '').split('?').pop());
    for (const k of ['station', 'stationCode', 'station_code', 'stationId', 'node', 'serviceAreaId']) {
      if (p.get(k)) return p.get(k);
    }
    return 'SIN-ESTACION';
  }

  // ---------- Lectura ----------
  function scrollParent(el) {
    for (let p = el && el.parentElement; p && p !== document.body; p = p.parentElement) {
      const oy = getComputedStyle(p).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight + 20) return p;
    }
    return document.scrollingElement;
  }

  async function collectAll() {
    const byRoute = new Map();
    const merge = () => parsePage().forEach((r) => byRoute.set(r.route, r));
    merge();
    const first = findRows()[0];
    if (!first) return [];
    const sc = scrollParent(first);
    if (sc && sc.scrollHeight > sc.clientHeight + 20) {
      const start = sc.scrollTop;
      sc.scrollTop = 0;
      await sleep(300);
      merge();
      while (sc.scrollTop + sc.clientHeight < sc.scrollHeight - 5) {
        const before = sc.scrollTop;
        sc.scrollTop += Math.max(200, sc.clientHeight * 0.8);
        await sleep(400);
        merge();
        if (sc.scrollTop === before) break;
      }
      sc.scrollTop = start;
    }
    return [...byRoute.values()].sort((a, b) => a.route.localeCompare(b.route, undefined, { numeric: true }));
  }

  // Espera hasta 2 min a que el portal pinte las rutas y el número se estabilice.
  async function waitForRows() {
    let last = -1;
    for (let i = 0; i < 40; i++) {
      const n = findRows().length;
      if (n > 0 && n === last) return true;
      last = n;
      await sleep(3000);
    }
    return last > 0;
  }

  // ---------- Guardado ----------
  const pct = (a, b) => (b > 0 ? (a / b) * 100 : null);

  function totals(routes) {
    const t = routes.reduce(
      (acc, r) => {
        acc.stopsDone += r.stopsDone; acc.stopsTotal += r.stopsTotal;
        acc.delDone += r.delDone; acc.delTotal += r.delTotal;
        acc.notDeparted += r.notDeparted ? 1 : 0;
        return acc;
      },
      { stopsDone: 0, stopsTotal: 0, delDone: 0, delTotal: 0, notDeparted: 0 }
    );
    t.routes = routes.length;
    t.stopsPct = pct(t.stopsDone, t.stopsTotal);
    t.delPct = pct(t.delDone, t.delTotal);
    return t;
  }

  async function save(station, routes) {
    const now = Date.now();
    const kSnap = 'snap:' + station, kPrev = 'prev:' + station, kHist = 'hist:' + station;
    const got = await chrome.storage.local.get([kSnap, kPrev, kHist, 'stations']);
    const snap = { station, url: location.href, ts: now, routes, totals: totals(routes) };
    const upd = { [kSnap]: snap };
    // El corte anterior se conserva para calcular el avance de los últimos ~15 min.
    const old = got[kSnap];
    upd[kPrev] = old && now - old.ts > 10 * 60 * 1000 ? old : got[kPrev] || null;
    const hist = (got[kHist] || []).concat({ ts: now, stopsPct: snap.totals.stopsPct, delPct: snap.totals.delPct }).slice(-200);
    upd[kHist] = hist;
    upd.stations = [...new Set([...(got.stations || []), station])];
    await chrome.storage.local.set(upd);
    chrome.runtime.sendMessage({ type: 'register', station });
    return { snap, prev: upd[kPrev] };
  }

  // ---------- Panel ----------
  let host, shadow, state = { minimized: false };
  try { state.minimized = sessionStorage.getItem('bdb-min') === '1'; } catch {}

  const fmt = (v) => (v == null ? '—' : v.toFixed(1) + '%');
  const color = (v) => (v == null ? '#9aa4ad' : v >= 75 ? '#1f9d55' : v >= 40 ? '#d69e2e' : '#e05252');
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const bar = (v) => `<div class="bar"><span style="width:${Math.min(100, v || 0)}%;background:${color(v)}"></span></div>`;

  function ensurePanel() {
    if (host) return;
    host = document.createElement('div');
    host.id = 'bdb-monitor-host';
    host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;';
    shadow = host.attachShadow({ mode: 'open' });
    document.body.appendChild(host);
  }

  async function render(snap, prev, msg) {
    ensurePanel();
    const next = await chrome.runtime.sendMessage({ type: 'nextRefresh' }).catch(() => null);
    const t = snap ? snap.totals : null;
    const prevBy = new Map((prev ? prev.routes : []).map((r) => [r.route, r]));
    const rows = snap
      ? [...snap.routes].sort((a, b) => (pct(a.stopsDone, a.stopsTotal) ?? -1) - (pct(b.stopsDone, b.stopsTotal) ?? -1))
      : [];
    const body = state.minimized
      ? ''
      : `
      ${msg ? `<div class="msg">${esc(msg)}</div>` : ''}
      ${t ? `
      <div class="kpis">
        <div><label>Paradas</label><b style="color:${color(t.stopsPct)}">${fmt(t.stopsPct)}</b><small>${t.stopsDone}/${t.stopsTotal}</small>${bar(t.stopsPct)}</div>
        <div><label>Entregas</label><b style="color:${color(t.delPct)}">${fmt(t.delPct)}</b><small>${t.delDone}/${t.delTotal}</small>${bar(t.delPct)}</div>
        <div><label>Rutas</label><b>${t.routes}</b><small>${t.notDeparted} sin salir</small></div>
      </div>
      <div class="tbl"><table>
        <thead><tr><th>Ruta</th><th>Driver</th><th>Paradas</th><th>Entregas</th><th title="Paradas hechas desde el corte anterior">Δ15m</th></tr></thead>
        <tbody>${rows.map((r) => {
          const sp = pct(r.stopsDone, r.stopsTotal), dp = pct(r.delDone, r.delTotal);
          const p = prevBy.get(r.route);
          const delta = p ? r.stopsDone - p.stopsDone : null;
          return `<tr>
            <td><b>${esc(r.route)}</b></td>
            <td title="${esc(r.status)}">${esc(r.drivers.join(' / ') || '—')}${r.notDeparted ? ' <em>sin salir</em>' : ''}</td>
            <td><span style="color:${color(sp)}">${fmt(sp)}</span><small>${r.stopsDone}/${r.stopsTotal}</small></td>
            <td><span style="color:${color(dp)}">${fmt(dp)}</span><small>${r.delDone}/${r.delTotal}</small></td>
            <td>${delta == null ? '—' : (delta > 0 ? '+' : '') + delta}</td>
          </tr>`;
        }).join('')}</tbody>
      </table></div>` : ''}`;

    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .p { font: 12px/1.35 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; color:#1b2733; background:#fff;
             border:1px solid #cfd8e0; border-radius:10px; box-shadow:0 8px 24px rgba(0,0,0,.18); width:${state.minimized ? '260px' : '520px'}; overflow:hidden; }
        .hd { display:flex; align-items:center; gap:8px; padding:8px 10px; background:#232f3e; color:#fff; }
        .hd .st { font-weight:700; font-size:13px; cursor:pointer; }
        .hd .meta { flex:1; opacity:.8; font-size:11px; }
        .hd button { background:#37475a; color:#fff; border:0; border-radius:6px; padding:4px 8px; cursor:pointer; font:inherit; }
        .hd button:hover { background:#485769; }
        .msg { padding:8px 10px; background:#fff8e1; border-bottom:1px solid #f0e2a8; }
        .kpis { display:grid; grid-template-columns:1fr 1fr .8fr; gap:8px; padding:10px; border-bottom:1px solid #e6ebef; }
        .kpis label { display:block; color:#5b6b7a; font-size:11px; }
        .kpis b { font-size:20px; margin-right:6px; }
        .kpis small, td small { color:#6b7a88; display:block; font-size:10.5px; }
        .bar { height:5px; background:#edf1f4; border-radius:3px; margin-top:4px; overflow:hidden; }
        .bar span { display:block; height:100%; }
        .tbl { max-height:50vh; overflow:auto; }
        table { width:100%; border-collapse:collapse; }
        th { position:sticky; top:0; background:#f5f7f9; text-align:left; font-weight:600; color:#4a5866; padding:6px 8px; border-bottom:1px solid #e1e6ea; }
        td { padding:5px 8px; border-bottom:1px solid #eef1f3; vertical-align:top; }
        td em { color:#e05252; font-style:normal; font-size:10.5px; }
      </style>
      <div class="p">
        <div class="hd">
          <span class="st" id="st" title="Clic para cambiar el nombre de la estación">${esc(snap ? snap.station : detectStation())}</span>
          <span class="meta">${snap ? 'Corte ' + new Date(snap.ts).toLocaleTimeString() : 'Leyendo…'}${next ? ' · próximo ' + new Date(next).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}</span>
          <button id="rf" title="Recargar ahora todas las estaciones">↻</button>
          <button id="db" title="Tablero de todas las estaciones">Tablero</button>
          <button id="mn">${state.minimized ? '▢' : '–'}</button>
        </div>
        ${body}
      </div>`;

    shadow.getElementById('mn').onclick = () => {
      state.minimized = !state.minimized;
      try { sessionStorage.setItem('bdb-min', state.minimized ? '1' : '0'); } catch {}
      render(snap, prev, msg);
    };
    shadow.getElementById('db').onclick = () => chrome.runtime.sendMessage({ type: 'openDashboard' });
    shadow.getElementById('rf').onclick = () => chrome.runtime.sendMessage({ type: 'refreshAll' });
    shadow.getElementById('st').onclick = () => {
      const v = prompt('Nombre de la estación para esta pestaña:', snap ? snap.station : detectStation());
      if (!v) return;
      try { sessionStorage.setItem('bdb-station', v.trim().toUpperCase()); } catch {}
      run();
    };
  }

  // ---------- Ciclo ----------
  async function run() {
    if (!(await waitForRows())) return; // página sin rutas: no se muestra nada
    const station = detectStation();
    const routes = await collectAll();
    if (!routes.length) return;
    const { snap, prev } = await save(station, routes);
    render(snap, prev);
  }

  run();
})();
