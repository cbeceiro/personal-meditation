"""Lo que comparten publicar.py y crear_usuario.py: el fichero .env y el acceso a Supabase."""
import os
import re
import sys
from pathlib import Path

import requests

RAIZ = Path(__file__).resolve().parent.parent
BUCKET = "meditaciones-audio"
DOMINIO = "t-med.app"  # el nombre de usuario se guarda en Supabase como usuario@DOMINIO; igual que en app/app.js


def cargar_env(*necesarias):
    fichero = RAIZ / ".env"
    if fichero.exists():
        for linea in fichero.read_text().splitlines():
            if "=" in linea and not linea.strip().startswith("#"):
                clave, valor = linea.split("=", 1)
                os.environ.setdefault(clave.strip(), valor.strip().strip("\"'"))
    faltan = [v for v in necesarias if not os.environ.get(v)]
    if faltan:
        sys.exit(f"Faltan variables en .env: {', '.join(faltan)}")


def email_de(usuario):
    if not re.fullmatch(r"[a-z0-9._-]+", usuario):
        sys.exit(f"Nombre de usuario no válido: «{usuario}» (solo minúsculas, números, punto, guion y guion bajo)")
    return f"{usuario}@{DOMINIO}"


class Supabase:
    def __init__(self):
        self.url = os.environ["SUPABASE_URL"].rstrip("/")
        clave = os.environ["SUPABASE_SECRET_KEY"]
        self.sesion = requests.Session()
        self.sesion.headers.update({"apikey": clave, "Authorization": f"Bearer {clave}"})

    def _pedir(self, metodo, ruta, **kw):
        r = self.sesion.request(metodo, f"{self.url}{ruta}", timeout=120, **kw)
        if not r.ok:
            sys.exit(f"Supabase respondió {r.status_code} en {ruta}: {r.text[:300]}")
        return r

    # Usuarios

    def id_de(self, usuario):
        """Id del usuario en Supabase Auth, o None si no existe."""
        email, pagina = email_de(usuario), 1
        while True:
            lote = self._pedir("GET", "/auth/v1/admin/users", params={"page": pagina, "per_page": 200}).json()["users"]
            for u in lote:
                if u["email"] == email:
                    return u["id"]
            if len(lote) < 200:
                return None
            pagina += 1

    def crear_usuario(self, usuario, clave):
        # email_confirm evita el correo de confirmación: la dirección no existe.
        cuerpo = {"email": email_de(usuario), "password": clave, "email_confirm": True}
        self._pedir("POST", "/auth/v1/admin/users", json=cuerpo)

    def cambiar_clave(self, id_usuario, clave):
        self._pedir("PUT", f"/auth/v1/admin/users/{id_usuario}", json={"password": clave})

    # Meditaciones

    def publicadas(self, id_usuario):
        params = {"select": "slug,texto_hash,audio_ruta,marcas", "user_id": f"eq.{id_usuario}"}
        return {f["slug"]: f for f in self._pedir("GET", "/rest/v1/meditaciones", params=params).json()}

    def subir_audio(self, ruta, audio):
        self._pedir(
            "POST",
            f"/storage/v1/object/{BUCKET}/{ruta}",
            data=audio,
            headers={"Content-Type": "audio/mpeg", "x-upsert": "true", "Cache-Control": "max-age=31536000"},
        )

    def borrar_audio(self, ruta):
        self._pedir("DELETE", f"/storage/v1/object/{BUCKET}/{ruta}")

    def guardar(self, fila):
        self._pedir(
            "POST",
            "/rest/v1/meditaciones",
            params={"on_conflict": "user_id,slug"},
            json=fila,
            headers={"Prefer": "resolution=merge-duplicates"},
        )

    def actualizar(self, id_usuario, slug, campos):
        params = {"user_id": f"eq.{id_usuario}", "slug": f"eq.{slug}"}
        self._pedir("PATCH", "/rest/v1/meditaciones", params=params, json=campos)

    def borrar(self, id_usuario, fila):
        params = {"user_id": f"eq.{id_usuario}", "slug": f"eq.{fila['slug']}"}
        self._pedir("DELETE", "/rest/v1/meditaciones", params=params)
        self.borrar_audio(fila["audio_ruta"])
