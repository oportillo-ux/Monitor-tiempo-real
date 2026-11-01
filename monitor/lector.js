// Funciones que el recolector (recolector.py) llama dentro de la página del portal.
// Se inyecta junto con extension/parser.js en cada carga de página.
(() => {
  const { parsePage, findRows } = globalThis.BDBParser;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const areaId = () => new URLSearchParams(location.search).get('serviceAreaId');
  const codeOf = (label) => (label.match(/\(([A-Z]{3}\d{1,2})\)/) || label.match(/^([A-Z]{3}\d{1,2})\b/) || [null, label])[1];
  const stationOptions = () => [...document.querySelectorAll('[role="option"]')].filter((o) => !o.disabled);
  const rowsSig = () => findRows().map((r) => (r.innerText || '').split('\n')[0]).join(',');

  async function openStationList() {
    const inp = document.querySelector('input[role="combobox"]');
    if (!inp) return [];
    if (!stationOptions().length) {
      for (const t of ['mousedown', 'mouseup', 'click']) inp.dispatchEvent(new MouseEvent(t, { bubbles: true }));
    }
    for (let i = 0; i < 15 && !stationOptions().length; i++) await sleep(200);
    return stationOptions();
  }

  async function listStations() {
    const opts = await openStationList();
    const labels = opts.map((o) => o.getAttribute('aria-label') || o.textContent.trim());
    const current = opts.find((o) => o.getAttribute('aria-selected') === 'true');
    if (current) current.click(); // cierra la lista sin cambiar de estación
    await sleep(300);
    return { labels, current: current ? current.getAttribute('aria-label') : null };
  }

  async function selectStation(label) {
    const before = areaId();
    const opt = (await openStationList()).find((o) => o.getAttribute('aria-label') === label);
    if (!opt) return false;
    const wasSelected = opt.getAttribute('aria-selected') === 'true';
    opt.click();
    if (wasSelected) return true;
    for (let i = 0; i < 50 && areaId() === before; i++) await sleep(200);
    return areaId() !== before;
  }

  // Número que el portal muestra como "N Total" en el recuadro de rutas.
  function routesTotal() {
    for (const el of document.querySelectorAll('div, span, p')) {
      if (el.children.length || el.textContent.trim() !== 'Total') continue;
      for (let p = el.parentElement, i = 0; p && i < 3; p = p.parentElement, i++) {
        const m = (p.innerText || '').trim().match(/^(\d+)\s*\n?\s*Total\b/);
        if (m) return +m[1];
      }
    }
    return null;
  }

  // Espera a que la estación pinte sus rutas (o confirme que no tiene).
  async function waitStationData(prevSig) {
    const t0 = Date.now();
    let last = null;
    while (Date.now() - t0 < 45000) {
      await sleep(1500);
      const total = routesTotal();
      const rows = findRows();
      const sig = rows.map((r) => (r.innerText || '').split('\n')[0]).join(',');
      const cur = total + '|' + sig;
      const ready = Date.now() - t0 > 3000 && total != null && (total === 0 ? rows.length === 0 : rows.length > 0 && sig !== prevSig);
      if (ready && cur === last) return true;
      last = ready ? cur : null;
    }
    return false;
  }

  function scrollParent(el) {
    for (let p = el && el.parentElement; p && p !== document.body; p = p.parentElement) {
      const oy = getComputedStyle(p).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight + 20) return p;
    }
    return document.scrollingElement;
  }

  // Lee todas las rutas, haciendo scroll si la lista es virtual.
  async function collectAll() {
    if (routesTotal() === 0) return [];
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

  // Espera hasta ~2 min a que la vista de rutas termine de cargar.
  async function waitRoutesPage() {
    let last = -1;
    for (let i = 0; i < 40; i++) {
      const n = findRows().length;
      const total = routesTotal();
      if (n === last && (n > 0 || (total === 0 && i >= 2))) return true;
      last = n;
      await sleep(3000);
    }
    return false;
  }

  globalThis.BDB = { codeOf, rowsSig, listStations, selectStation, routesTotal, waitStationData, collectAll, waitRoutesPage };
})();
