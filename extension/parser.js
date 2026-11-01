// Lee las filas de rutas del portal a partir de su texto visible:
// "CV28 ... Ismael Ruiz Huerta ... 2/116 stops ... 1/144 deliveries".
// No depende de clases CSS del portal, solo del formato del texto.
(() => {
  const STOPS_RE = /(\d+)\s*\/\s*(\d+)\s*stops?\b/i;
  const STOPS_RE_G = /\d+\s*\/\s*\d+\s*stops?\b/gi;
  const DELIV_RE = /(\d+)\s*\/\s*(\d+)\s*deliver(?:y|ies)\b/i;
  const ROUTE_RE = /^[A-Z]{1,5}\d{1,5}[A-Z]?$/;
  const DURATION_RE = /^(\d+\s*h)?\s*(\d+\s*m)?$/i;
  const CLOCK_RE = /^\d{1,2}:\d{2}\s*(am|pm)?$/i;
  const STATUS_RE = /^(\||not departed|departed|time left|app sign|avg|on route|at station|returning|returned|completed|done|in progress|break|rescue|late|ahead|behind|on time)/i;
  const NAME_RE = /^[A-Za-zÀ-ÿñÑ'’.\- ]{3,}(\.\.\.|…)?$/;

  function textOf(el) {
    return (el.innerText || el.textContent || '').replace(/ /g, ' ');
  }

  // Elementos más profundos cuyo texto es "X/Y stops".
  function stopsLeaves(root) {
    const out = [];
    for (const el of root.querySelectorAll('*')) {
      if (el.closest('#bdb-monitor-host')) continue;
      const t = el.textContent;
      if (!t || t.length > 60 || !STOPS_RE.test(t)) continue;
      if ([...el.children].some((c) => STOPS_RE.test(c.textContent))) continue;
      out.push(el);
    }
    return out;
  }

  // Sube desde "X/Y stops" hasta el contenedor que tiene la ruta y las entregas,
  // sin llegar a uno que contenga otra fila.
  function rowFor(leaf, root) {
    let el = leaf.parentElement;
    while (el && el !== root.parentElement) {
      const t = textOf(el);
      if ((t.match(STOPS_RE_G) || []).length > 1) return null;
      if (DELIV_RE.test(t) && lines(t).some((l) => ROUTE_RE.test(l))) return el;
      el = el.parentElement;
    }
    return null;
  }

  function lines(t) {
    return t.split('\n').map((s) => s.trim()).filter(Boolean);
  }

  function isDriverLine(l) {
    if (ROUTE_RE.test(l) || CLOCK_RE.test(l) || STATUS_RE.test(l)) return false;
    if (DURATION_RE.test(l.replace(/\s+/g, ''))) return false;
    if (l.includes('|') || l.includes(':') || /\d/.test(l)) return false;
    if (/stops?|deliver/i.test(l)) return false;
    return NAME_RE.test(l) && l.trim().split(/\s+/).length >= 2;
  }

  function parseRow(row) {
    const t = textOf(row);
    const ls = lines(t);
    const s = t.match(STOPS_RE);
    const d = t.match(DELIV_RE);
    const route = ls.find((l) => ROUTE_RE.test(l));
    if (!s || !route) return null;
    const drivers = ls.filter(isDriverLine).map((n) => n.replace(/\s*(\.\.\.|…)$/, '').trim());
    const status = ls.filter((l) => STATUS_RE.test(l) || l.includes('|')).join(' ').replace(/\s+/g, ' ').trim();
    return {
      route,
      drivers: [...new Set(drivers)],
      status,
      notDeparted: /not departed/i.test(t),
      stopsDone: +s[1],
      stopsTotal: +s[2],
      delDone: d ? +d[1] : 0,
      delTotal: d ? +d[2] : 0,
    };
  }

  function findRows(root = document.body) {
    const rows = new Set();
    for (const leaf of stopsLeaves(root)) {
      const r = rowFor(leaf, root);
      if (r) rows.add(r);
    }
    return [...rows];
  }

  function parsePage(root = document.body) {
    return findRows(root).map(parseRow).filter(Boolean);
  }

  globalThis.BDBParser = { findRows, parseRow, parsePage };
})();
