#!/usr/bin/env python3
"""Crea un usuario de T-med, o le cambia la contraseña si ya existe.

Uso:
  python3 herramientas/crear_usuario.py ana

La contraseña se pide por teclado y no se muestra ni queda en el historial de la terminal.
"""
import getpass
import sys

from comun import Supabase, cargar_env

MINIMO = 8  # caracteres de la contraseña


def pedir_clave():
    clave = getpass.getpass("Contraseña: ")
    if len(clave) < MINIMO:
        sys.exit(f"La contraseña debe tener al menos {MINIMO} caracteres.")
    if clave != getpass.getpass("Repítela: "):
        sys.exit("Las contraseñas no coinciden.")
    return clave


def main():
    if len(sys.argv) != 2 or sys.argv[1].startswith("-"):
        sys.exit(__doc__)
    usuario = sys.argv[1]
    cargar_env("SUPABASE_URL", "SUPABASE_SECRET_KEY")
    supa = Supabase()
    id_usuario = supa.id_de(usuario)
    if id_usuario:
        if input(f"«{usuario}» ya existe. ¿Cambiar su contraseña? [s/N] ").strip().lower() != "s":
            return
        supa.cambiar_clave(id_usuario, pedir_clave())
        print(f"Contraseña de «{usuario}» cambiada.")
    else:
        supa.crear_usuario(usuario, pedir_clave())
        print(f"Usuario «{usuario}» creado. Sus meditaciones van en meditaciones/{usuario}/")


if __name__ == "__main__":
    main()
