// Tablero de los clientes: lee datos/estado.json (lo escribe recolector.py) cada 30 s.
const VIEJO_MS = 25 * 60 * 1000;
const $ = (id) => document.getElementById(id);
const pct = (a, b) => (b > 0 ? (a / b) * 100 : null);
const fmt = (v) => (v == null ? '—' : v.toFixed(1) + '%');
const color = (v) => (v == null ? 'var(--muted)' : v >= 75 ? 'var(--good)' : v >= 40 ? 'var(--mid)' : 'var(--bad)');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const track = (v) => `<div class="track"><span style="width:${Math.min(100, v || 0)}%;background:${color(v)}"></span></div>`;
const hhmm = (s) => new Date(s * 1000).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });

let estado = null;
// Estaciones elegidas en la botonera; vacío = todas.
let elegidas = new Set();

try {
  const o = localStorage.getItem('bdb-orden');
  if (o) $('orden').value = o;
  elegidas = new Set(JSON.parse(localStorage.getItem('bdb-estaciones') || '[]'));
} catch {}
if (!$('orden').value) $('orden').value = 'avance';

async function cargar() {
  try {
    const r = await fetch('datos/estado.json', { cache: 'no-store' });
    if (r.ok) estado = await r.json();
  } catch {}
  pintar();
}

function sumar(estaciones) {
  const t = { rutas: 0, sin_salir: 0, paradas_hechas: 0, paradas_total: 0, entregas_hechas: 0, entregas_total: 0 };
  for (const e of estaciones) for (const k in t) t[k] += (e.totales && e.totales[k]) || 0;
  t.pct = pct(t.entregas_hechas, t.entregas_total);
  return t;
}

function clientesOrdenados() {
  if (!estado) return [];
  const orden = estado.orden || Object.keys(estado.clientes || {});
  return orden.filter((n) => estado.clientes[n]).map((n) => ({ nombre: n, ...estado.clientes[n] }));
}

function guardarEstaciones() {
  try { localStorage.setItem('bdb-estaciones', JSON.stringify([...elegidas])); } catch {}
}

function pintarBotonera(todos) {
  const codigos = [...new Set(todos.flatMap((c) => (c.estaciones || []).map((e) => e.codigo)))]
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  // Olvida estaciones que ya no aparecen en los datos.
  if (estado) for (const c of elegidas) if (!codigos.includes(c)) elegidas.delete(c);
  const nav = $('estaciones');
  nav.hidden = codigos.length < 2;
  nav.innerHTML = `<span class="etq">Estaciones</span>`
    + `<button type="button" data-est="" aria-pressed="${elegidas.size === 0}">Todas</button>`
    + codigos.map((c) => `<button type="button" data-est="${esc(c)}" aria-pressed="${elegidas.has(c)}">${esc(c)}</button>`).join('');
}

function pintar() {
  const ahora = Date.now();
  const todos = clientesOrdenados();
  pintarBotonera(todos);
  // Con estaciones elegidas, cada cliente muestra solo esas y se ocultan los que no tienen ninguna.
  const clientes = elegidas.size === 0 ? todos : todos
    .map((c) => ({ ...c, estaciones: (c.estaciones || []).filter((e) => elegidas.has(e.codigo)) }))
    .filter((c) => c.estaciones.length > 0);
  $('vacio').hidden = todos.length > 0;

  if (estado) {
    const partes = [];
    if (estado.actualizando) partes.push('Actualizando…');
    else if (estado.ciclo_fin) partes.push('Actualizado ' + hhmm(estado.ciclo_fin));
    if (estado.proximo && !estado.actualizando) partes.push('próximo ' + hhmm(estado.proximo));
    partes.push(todos.length + ' cliente(s)');
    $('meta').textContent = partes.join(' · ');
  }

  // Tarjetas por cliente.
  $('clientes').innerHTML = clientes.map((c) => {
    const ests = c.estaciones || [];
    const t = sumar(ests);
    const viejo = !c.ts || ahora - c.ts * 1000 > VIEJO_MS || c.estado !== 'ok';
    const lista = ests.map((e) => e.totales && e.totales.rutas
      ? `<div><b>${esc(e.codigo)}</b>${track(e.totales.pct_entregas)}<span>${fmt(e.totales.pct_entregas)}</span></div>`
      : `<div class="sin"><b>${esc(e.codigo)}</b><span>${e.error ? esc(e.error) : 'Sin rutas hoy'}</span><span></span></div>`).join('');
    return `<div class="card">
      <h3>${esc(c.nombre)} <span class="ts ${viejo ? 'viejo' : ''}">${c.ts ? 'corte ' + hhmm(c.ts) : 'sin datos'}</span></h3>
      ${c.estado && c.estado !== 'ok' ? `<div class="aviso">${esc(c.mensaje)}</div>` : ''}
      <div class="kpi"><div class="top"><label>Avance de entregas</label><b style="color:${color(t.pct)}">${fmt(t.pct)}</b></div>
        ${track(t.pct)}<div class="info">${t.entregas_hechas} de ${t.entregas_total} entregas</div></div>
      <div class="info">Paradas: ${t.paradas_hechas} de ${t.paradas_total} · ${t.rutas} rutas · ${t.sin_salir} sin salir</div>
      ${lista ? `<div class="est">${lista}</div>` : ''}
    </div>`;
  }).join('');

  // Selector de cliente.
  const sel = $('cliente');
  const elegido = sel.value;
  sel.innerHTML = '<option value="">Todos los clientes</option>' + clientes.map((c) => `<option>${esc(c.nombre)}</option>`).join('');
  sel.value = clientes.some((c) => c.nombre === elegido) ? elegido : '';

  // Tabla de drivers.
  const q = $('filtro').value.trim().toLowerCase();
  const filas = clientes
    .filter((c) => !sel.value || c.nombre === sel.value)
    .flatMap((c) => (c.estaciones || []).flatMap((e) => (e.rutas || []).map((r) => ({
      ...r, cliente: c.nombre, estacion: e.codigo,
      previo: e.previo && e.previo.entregas ? e.previo.entregas[r.route] : undefined,
    }))))
    .filter((r) => !q || `${r.cliente} ${r.estacion} ${r.route} ${r.drivers.join(' ')}`.toLowerCase().includes(q));

  filas.sort($('orden').value === 'ruta'
    ? (a, b) => a.cliente.localeCompare(b.cliente) || a.estacion.localeCompare(b.estacion) || a.route.localeCompare(b.route, undefined, { numeric: true })
    : (a, b) => (pct(a.delDone, a.delTotal) ?? -1) - (pct(b.delDone, b.delTotal) ?? -1));

  $('filas').innerHTML = filas.map((r) => {
    const dp = pct(r.delDone, r.delTotal);
    const delta = r.previo == null ? null : r.delDone - r.previo;
    return `<tr>
      <td>${esc(r.cliente)}</td>
      <td>${esc(r.estacion)}</td>
      <td><b>${esc(r.route)}</b></td>
      <td>${esc(r.drivers.join(' / ') || '—')}</td>
      <td class="estado">${r.notDeparted ? '<span class="tag">Sin salir</span> ' : ''}${esc(r.status.replace(/not departed\s*\|?/i, ''))}</td>
      <td><b style="color:${color(dp)}">${fmt(dp)}</b> <span class="sub">${r.delDone}/${r.delTotal}</span>${track(dp)}</td>
      <td class="sub">${r.stopsDone}/${r.stopsTotal}</td>
      <td>${delta == null ? '—' : (delta > 0 ? '+' : '') + delta}</td>
    </tr>`;
  }).join('');
}

// Clic en una estación la suma o la quita; "Todas" limpia la selección.
$('estaciones').addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-est]');
  if (!b) return;
  const c = b.dataset.est;
  if (!c) elegidas.clear();
  else if (elegidas.has(c)) elegidas.delete(c);
  else elegidas.add(c);
  guardarEstaciones();
  pintar();
});
$('filtro').addEventListener('input', pintar);
$('cliente').addEventListener('change', pintar);
$('orden').addEventListener('change', () => {
  try { localStorage.setItem('bdb-orden', $('orden').value); } catch {}
  pintar();
});
$('actualizar').addEventListener('click', async () => {
  const b = $('actualizar');
  b.disabled = true;
  try { await fetch('api/actualizar', { method: 'POST' }); } catch {}
  setTimeout(() => { b.disabled = false; cargar(); }, 3000);
});

setInterval(cargar, 30 * 1000);
cargar();
