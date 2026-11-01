"""Alta, cambio y baja de clientes del monitor.

La contraseña de cada cliente se guarda en el Administrador de credenciales de
Windows (servicio "BDB-Monitor"); en clientes.json solo quedan el nombre, el
usuario y las estaciones a seguir.
"""
import getpass
import json
from pathlib import Path

import keyring

SERVICIO = "BDB-Monitor"
ARCHIVO = Path(__file__).with_name("clientes.json")


def cargar():
    if ARCHIVO.exists():
        return json.loads(ARCHIVO.read_text(encoding="utf-8-sig"))
    return {"clientes": []}


def guardar(cfg):
    ARCHIVO.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")


def listar(cfg):
    if not cfg["clientes"]:
        print("\n  (sin clientes)\n")
        return
    print()
    for i, c in enumerate(cfg["clientes"], 1):
        tiene = "sí" if keyring.get_password(SERVICIO, c["nombre"]) else "NO"
        est = ", ".join(c.get("estaciones") or []) or "todas"
        print(f"  {i}. {c['nombre']}  usuario: {c['usuario']}  estaciones: {est}  contraseña guardada: {tiene}")
    print()


def agregar(cfg):
    nombre = input("Nombre del cliente (como quieres verlo en el tablero): ").strip()
    if not nombre:
        return
    usuario = input("Usuario (correo) del portal de Amazon: ").strip()
    clave = getpass.getpass("Contraseña (no se muestra al escribir): ")
    est = input("Estaciones a seguir separadas por coma (vacío = todas): ").strip()
    estaciones = [e.strip().upper() for e in est.split(",") if e.strip()]
    cfg["clientes"] = [c for c in cfg["clientes"] if c["nombre"] != nombre]
    cfg["clientes"].append({"nombre": nombre, "usuario": usuario, "estaciones": estaciones})
    guardar(cfg)
    if clave:
        keyring.set_password(SERVICIO, nombre, clave)
    print(f"\n  Cliente '{nombre}' guardado.\n")


def eliminar(cfg):
    listar(cfg)
    n = input("Número del cliente a eliminar: ").strip()
    if not n.isdigit() or not 1 <= int(n) <= len(cfg["clientes"]):
        return
    c = cfg["clientes"].pop(int(n) - 1)
    guardar(cfg)
    try:
        keyring.delete_password(SERVICIO, c["nombre"])
    except keyring.errors.PasswordDeleteError:
        pass
    print(f"\n  Cliente '{c['nombre']}' eliminado.\n")


def main():
    cfg = cargar()
    while True:
        print("BDB Monitor - clientes")
        print("  1) Ver clientes   2) Agregar o actualizar   3) Eliminar   4) Salir")
        op = input("Opción: ").strip()
        if op == "1":
            listar(cfg)
        elif op == "2":
            agregar(cfg)
        elif op == "3":
            eliminar(cfg)
        elif op == "4":
            break


if __name__ == "__main__":
    main()
