"""Recolector del monitor BDB.

Cada 15 minutos entra al portal de Amazon Logistics de cada cliente (con su
usuario y contraseña guardados por configurar.py), recorre sus estaciones, lee
las rutas y guarda todo en datos/estado.json. Además sirve el tablero en
http://<esta-PC>:8080.

Uso:
  python recolector.py                 corre el monitor
  python recolector.py --una-vez       hace un solo ciclo y termina
  python recolector.py --abrir NOMBRE  abre el navegador de ese cliente para
                                       resolver a mano una verificación de Amazon
"""
import argparse
import asyncio
import json
import re
import sys
import threading
import time
from datetime import datetime
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import keyring
from playwright.async_api import async_playwright

SERVICIO = "BDB-Monitor"
BASE = Path(__file__).resolve().parent
DATOS = BASE / "datos"
PERFILES = BASE / "perfiles"
ESTADO = DATOS / "estado.json"
PORTAL = "https://logistics.amazon.com/operations/execution/itineraries"
INIT_JS = (BASE.parent / "extension" / "parser.js").read_text(encoding="utf-8") + "\n" + (BASE / "lector.js").read_text(encoding="utf-8")

actualizar_ya = threading.Event()


def log(msg):
    print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)


def cargar_config():
    cfg = json.loads((BASE / "clientes.json").read_text(encoding="utf-8-sig"))
    cfg.setdefault("intervalo_min", 15)
    cfg.setdefault("puerto", 8080)
    cfg.setdefault("navegador_visible", False)
    return cfg


def slug(nombre):
    return re.sub(r"[^A-Za-z0-9_-]+", "_", nombre).strip("_") or "cliente"


def code_of(label):
    m = re.search(r"\(([A-Z]{3}\d{1,2})\)", label) or re.match(r"([A-Z]{3}\d{1,2})\b", label)
    return m.group(1) if m else label


def pct(a, b):
    return round(a / b * 100, 1) if b else None


def totales(rutas):
    t = {
        "rutas": len(rutas),
        "sin_salir": sum(1 for r in rutas if r["notDeparted"]),
        "paradas_hechas": sum(r["stopsDone"] for r in rutas),
        "paradas_total": sum(r["stopsTotal"] for r in rutas),
        "entregas_hechas": sum(r["delDone"] for r in rutas),
        "entregas_total": sum(r["delTotal"] for r in rutas),
    }
    t["pct_entregas"] = pct(t["entregas_hechas"], t["entregas_total"])
    return t


# ---------------------------------------------------------------- navegador

async def ev(page, expr, arg=None, intentos=3):
    """page.evaluate que sobrevive a que el portal recargue la página a mitad."""
    for i in range(intentos):
        try:
            return await page.evaluate(expr, arg)
        except Exception as e:  # el portal navegó: se espera y se reintenta
            if i == intentos - 1 or not re.search(r"context|navigat|destroyed|Target", str(e), re.I):
                raise
            await page.wait_for_load_state("domcontentloaded")
            await page.wait_for_timeout(3000)


async def abrir_contexto(pw, cliente, visible):
    args = [] if visible else ["--window-position=-32000,-32000"]
    opciones = dict(
        user_data_dir=str(PERFILES / slug(cliente["nombre"])),
        headless=False,
        locale="en-US",
        timezone_id="America/Monterrey",
        viewport={"width": 1500, "height": 900},
        args=args,
    )
    try:
        return await pw.chromium.launch_persistent_context(channel="chrome", **opciones)
    except Exception:
        return await pw.chromium.launch_persistent_context(**opciones)


async def iniciar_sesion(page, cliente):
    """Devuelve 'ok' o el motivo por el que no se pudo entrar."""
    clave = keyring.get_password(SERVICIO, cliente["nombre"])
    for _ in range(6):
        await page.wait_for_load_state("domcontentloaded")
        if "logistics.amazon" in page.url and "/ap/" not in page.url:
            return "ok"
        if await page.locator("#captchacharacters, #auth-captcha-image, form[action*='validateCaptcha']").count():
            return "verificacion"
        if await page.locator("input[name='otpCode'], #auth-mfa-otpcode, input[name='code']").count():
            return "verificacion"
        if not clave:
            return "sin_clave"
        email = page.locator("#ap_email:visible, input[name='email']:visible")
        if await email.count():
            await email.first.fill(cliente["usuario"])
            cont = page.locator("#continue:visible, input#continue:visible")
            if await cont.count() and not await page.locator("#ap_password:visible").count():
                await cont.first.click()
                await page.wait_for_timeout(2500)
        pwd = page.locator("#ap_password:visible")
        if await pwd.count():
            await pwd.fill(clave)
            recordar = page.locator("input[name='rememberMe']")
            if await recordar.count():
                await recordar.first.check()
            await page.locator("#signInSubmit").click()
            await page.wait_for_timeout(5000)
            if await page.locator("#auth-error-message-box, .a-alert-error:visible").count():
                return "clave_incorrecta"
        else:
            await page.wait_for_timeout(3000)
    return "ok" if "logistics.amazon" in page.url and "/ap/" not in page.url else "no_entro"


MOTIVOS = {
    "verificacion": "Amazon pidió una verificación (captcha o código). Ábrelo a mano con: python recolector.py --abrir \"{n}\"",
    "sin_clave": "No hay contraseña guardada. Agrégala con configurar.py",
    "clave_incorrecta": "Amazon rechazó el usuario o la contraseña. Actualízalos con configurar.py",
    "no_entro": "No se pudo entrar al portal. Revisa con: python recolector.py --abrir \"{n}\"",
    "sin_rutas": "La vista de rutas no cargó a tiempo",
}


async def leer_cliente(pw, cliente, visible):
    ctx = await abrir_contexto(pw, cliente, visible)
    try:
        await ctx.add_init_script(INIT_JS)
        page = ctx.pages[0] if ctx.pages else await ctx.new_page()
        await page.goto(PORTAL, wait_until="domcontentloaded", timeout=90000)
        estado = await iniciar_sesion(page, cliente)
        if estado != "ok":
            return {"estado": estado, "mensaje": MOTIVOS[estado].format(n=cliente["nombre"]), "estaciones": []}
        if "/dv/routes" not in page.url:
            await page.goto(PORTAL, wait_until="domcontentloaded", timeout=90000)
        if not await ev(page, "BDB.waitRoutesPage()"):
            return {"estado": "sin_rutas", "mensaje": MOTIVOS["sin_rutas"], "estaciones": []}

        filtro = set(cliente.get("estaciones") or [])
        listado = await ev(page, "BDB.listStations()")
        etiquetas = [l for l in listado["labels"] if not filtro or code_of(l) in filtro]
        en = listado["current"]
        estaciones = []
        for etq in etiquetas:
            codigo = code_of(etq)
            if etq != en:
                firma = await ev(page, "BDB.rowsSig()")
                if not await ev(page, "l => BDB.selectStation(l)", etq):
                    estaciones.append({"codigo": codigo, "nombre": etq, "error": "No se pudo elegir la estación"})
                    continue
                en = etq
                await ev(page, "s => BDB.waitStationData(s)", firma)
            rutas = await ev(page, "BDB.collectAll()")
            estaciones.append({"codigo": codigo, "nombre": etq, "ts": time.time(), "rutas": rutas, "totales": totales(rutas)})
            log(f"  {cliente['nombre']} / {codigo}: {len(rutas)} rutas")
        return {"estado": "ok", "mensaje": "", "estaciones": estaciones}
    finally:
        await ctx.close()


# ---------------------------------------------------------------- estado

def leer_estado():
    if ESTADO.exists():
        try:
            return json.loads(ESTADO.read_text(encoding="utf-8"))
        except ValueError:
            pass
    return {"clientes": {}}


def escribir_estado(estado):
    DATOS.mkdir(exist_ok=True)
    tmp = ESTADO.with_suffix(".tmp")
    tmp.write_text(json.dumps(estado, ensure_ascii=False), encoding="utf-8")
    tmp.replace(ESTADO)


def fusionar(anterior, nombre, res):
    """Agrega al resultado nuevo el corte anterior (para Δ 15 min) y la tendencia."""
    viejo = {e["codigo"]: e for e in anterior.get("estaciones", [])}
    for est in res["estaciones"]:
        prev = viejo.get(est["codigo"])
        if not prev or "rutas" not in est:
            continue
        # El corte anterior solo cuenta si tiene al menos 10 min; si no, se conserva el de antes.
        if prev.get("ts") and est["ts"] - prev["ts"] >= 600:
            est["previo"] = {"ts": prev["ts"], "entregas": {r["route"]: r["delDone"] for r in prev.get("rutas", [])}}
        elif prev.get("previo"):
            est["previo"] = prev["previo"]
        hist = (prev.get("historia") or []) + [{"ts": est["ts"], "pct": est["totales"]["pct_entregas"]}]
        est["historia"] = hist[-100:]
    if res["estado"] != "ok":
        # Sin acceso: se muestran los últimos datos que se tenían, marcados como viejos.
        res["estaciones"] = anterior.get("estaciones", [])
    res["ts"] = time.time()
    return res


async def ciclo(pw, cfg):
    estado = leer_estado()
    estado["ciclo_inicio"] = time.time()
    estado["actualizando"] = True
    escribir_estado(estado)
    nombres = [c["nombre"] for c in cfg["clientes"]]
    for cliente in cfg["clientes"]:
        log(f"Leyendo {cliente['nombre']}…")
        try:
            res = await leer_cliente(pw, cliente, cfg["navegador_visible"])
        except Exception as e:
            log(f"  error: {e}")
            res = {"estado": "error", "mensaje": f"Error al leer el portal: {str(e).splitlines()[0][:200]}", "estaciones": []}
        estado["clientes"][cliente["nombre"]] = fusionar(estado["clientes"].get(cliente["nombre"], {}), cliente["nombre"], res)
        estado["orden"] = nombres
        escribir_estado(estado)
    # Clientes dados de baja dejan de mostrarse.
    estado["clientes"] = {n: estado["clientes"][n] for n in nombres if n in estado["clientes"]}
    estado["actualizando"] = False
    estado["ciclo_fin"] = time.time()
    estado["proximo"] = time.time() + cfg["intervalo_min"] * 60
    escribir_estado(estado)
    log("Ciclo terminado.")


# ---------------------------------------------------------------- tablero

class Tablero(SimpleHTTPRequestHandler):
    def translate_path(self, path):
        if path.split("?")[0] == "/datos/estado.json":
            return str(ESTADO)
        return super().translate_path(path)

    def do_POST(self):
        if self.path == "/api/actualizar":
            actualizar_ya.set()
            self.send_response(204)
            self.end_headers()
        else:
            self.send_error(404)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *a):
        pass


def servir(puerto):
    httpd = ThreadingHTTPServer(("0.0.0.0", puerto), partial(Tablero, directory=str(BASE / "tablero")))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    log(f"Tablero en http://localhost:{puerto}")


# ---------------------------------------------------------------- main

async def principal(una_vez):
    cfg = cargar_config()
    if not cfg["clientes"]:
        sys.exit("No hay clientes. Agrégalos con: python configurar.py")
    if not una_vez:
        servir(cfg["puerto"])
    async with async_playwright() as pw:
        while True:
            cfg = cargar_config()  # toma altas y bajas sin reiniciar
            await ciclo(pw, cfg)
            if una_vez:
                return
            fin = time.time() + cfg["intervalo_min"] * 60
            while time.time() < fin and not actualizar_ya.is_set():
                await asyncio.sleep(1)
            actualizar_ya.clear()


async def abrir(nombre):
    cfg = cargar_config()
    cliente = next((c for c in cfg["clientes"] if c["nombre"] == nombre), None)
    if not cliente:
        sys.exit(f"No existe el cliente '{nombre}'")
    async with async_playwright() as pw:
        ctx = await abrir_contexto(pw, cliente, visible=True)
        page = ctx.pages[0] if ctx.pages else await ctx.new_page()
        await page.goto(PORTAL)
        print("Resuelve la verificación en la ventana y ciérrala cuando veas el portal.")
        await ctx.wait_for_event("close", timeout=0)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--una-vez", action="store_true")
    ap.add_argument("--abrir")
    a = ap.parse_args()
    asyncio.run(abrir(a.abrir) if a.abrir else principal(a.una_vez))
