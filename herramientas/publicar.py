#!/usr/bin/env python3
"""Publica las meditaciones de meditaciones/<usuario>/*.md: genera la voz y el fondo, los mezcla y sube el audio a Supabase.

Uso:
  python3 herramientas/publicar.py                    publica las meditaciones nuevas o modificadas
  python3 herramientas/publicar.py FICHERO.md ...     solo esas meditaciones
  python3 herramientas/publicar.py --escuchar ...     genera el audio en escucha/ sin subir nada
  python3 herramientas/publicar.py --forzar ...       regenera la voz y el fondo, sin reutilizar lo ya generado
  python3 herramientas/publicar.py --borrar ana/calma retira esa meditación de la app y borra su audio

Los textos solo viven en este ordenador, así que borrar un fichero no retira nada: hay que usar --borrar.
"""
import argparse
import hashlib
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import requests

from comun import RAIZ, Supabase, cargar_env

MEDITACIONES = RAIZ / "meditaciones"
ESCUCHA = RAIZ / "escucha"
CACHE = RAIZ / ".cache"  # voz de cada párrafo y fondos ya generados, para no volver a pagarlos
KBPS = 128  # de la voz tal como llega de ElevenLabs
HZ = 44100
KBPS_FINAL = 96  # del audio mezclado que se publica
MODELO = "eleven_v4"  # entiende etiquetas de estilo en el texto, como [whispering]; no tiene control de velocidad
PAUSA = 2.0  # segundos de silencio entre párrafos seguidos; las pausas largas se marcan con [pausa N]
ENTRADA = 6  # segundos de fondo antes de que empiece la voz
SALIDA = 12  # segundos de fondo después de la voz, apagándose
VOLUMEN_FONDO = 0.2
MUSICA_S = 180  # duración de la música que se pide; después se repite en bucle
AMBIENTE_S = 30  # lo máximo que genera de una vez el modelo de efectos de sonido

MARCA_PAUSA = r"\[pausa\s+(\d+(?:[.,]\d+)?)\]"


def leer_meditacion(ruta):
    crudo = ruta.read_text(encoding="utf-8")
    meta = {}
    if crudo.startswith("---"):
        _, cabecera, crudo = crudo.split("---", 2)
        for linea in cabecera.strip().splitlines():
            clave, _, valor = linea.partition(":")
            meta[clave.strip()] = valor.strip()
    fondo = meta.get("fondo", "")
    tipo = meta.get("fondo_tipo", "musica")
    if tipo not in ("musica", "ambiente"):
        sys.exit(f"{ruta}: fondo_tipo debe ser «musica» o «ambiente»")
    return {
        "usuario": ruta.parent.name,
        "slug": ruta.stem,
        "titulo": meta.get("titulo", ruta.stem),
        "descripcion": meta.get("descripcion", ""),
        "orden": int(meta.get("orden", 0)),
        "fondo": "" if fondo.lower() == "ninguno" else fondo,
        "fondo_tipo": tipo,
        "volumen_fondo": float(meta.get("volumen_fondo", VOLUMEN_FONDO)),
        "texto": crudo.strip(),
    }


def trozos_de(texto):
    """Párrafos (str) y pausas marcadas con [pausa N] (float, en segundos), en orden."""
    texto = re.sub(rf"^[ \t]*{MARCA_PAUSA}[ \t]*$", r"\n\n\g<0>\n\n", texto, flags=re.M | re.I)
    trozos = []
    for bloque in re.split(r"\n\s*\n", texto):
        bloque = bloque.strip()
        pausa = re.fullmatch(MARCA_PAUSA, bloque, re.I)
        if pausa:
            trozos.append(float(pausa.group(1).replace(",", ".")))
        elif bloque:
            trozos.append(bloque)
    return trozos


MARCO = 144 * KBPS * 1000 // HZ  # bytes por marco MP3


def solo_audio(mp3):
    """Quita la etiqueta ID3 y el marco «Info» iniciales para poder encadenar varios MP3 en uno.

    El marco «Info» declara la duración del fichero original; si se deja, los reproductores
    creen que el audio unido dura lo que el primer trozo.
    """
    if mp3[:3] == b"ID3":
        tam = (mp3[6] << 21) | (mp3[7] << 14) | (mp3[8] << 7) | mp3[9]
        mp3 = mp3[10 + tam:]
    if mp3[21:25] in (b"Info", b"Xing"):
        mp3 = mp3[MARCO + ((mp3[2] >> 1) & 1):]
    return mp3


def silencio(segundos):
    """Marcos MP3 mudos (mono, 44,1 kHz, 128 kbps): cabecera y el resto a cero."""
    marco = b"\xff\xfb\x90\xc0".ljust(MARCO, b"\0")
    return marco * round(segundos * HZ / 1152)


def pedir_elevenlabs(ruta, cuerpo):
    for intento in range(3):
        r = requests.post(
            f"https://api.elevenlabs.io/v1/{ruta}",
            params={"output_format": f"mp3_{HZ}_{KBPS}"},
            headers={"xi-api-key": os.environ["ELEVENLABS_API_KEY"]},
            json=cuerpo,
            timeout=600,
        )
        if r.ok:
            return r.content
        if r.status_code != 429 and r.status_code < 500:
            break
        time.sleep(5 * (intento + 1))
    sys.exit(f"ElevenLabs respondió {r.status_code} en {ruta}: {r.text[:300]}")


def huella_de(*partes, largo=20):
    return hashlib.sha256("|".join(map(str, partes)).encode()).hexdigest()[:largo]


def voz_elevenlabs(texto, voz, modelo, forzar=False):
    # Cada párrafo se genera por separado y se une con silencio: el modelo por sí solo
    # apenas hace pausa en los puntos y aparte, y así solo se paga por los párrafos que cambian.
    trozos = trozos_de(texto)
    parrafos = [t for t in trozos if isinstance(t, str)]
    (CACHE / "voz").mkdir(parents=True, exist_ok=True)
    audio, i, nuevos, tras_parrafo = b"", 0, 0, False
    for trozo in trozos:
        if not isinstance(trozo, str):
            audio += silencio(trozo)
            tras_parrafo = False
            continue
        if tras_parrafo:
            audio += silencio(PAUSA)
        guardado = CACHE / "voz" / f"{huella_de(voz, modelo, trozo)}.mp3"
        if not guardado.exists() or forzar:
            cuerpo = {
                "text": trozo,
                "model_id": modelo,
                "voice_settings": {"stability": 0.6, "similarity_boost": 0.8},
            }
            # El contexto de los párrafos vecinos mantiene la entonación entre peticiones.
            if i > 0:
                cuerpo["previous_text"] = "\n\n".join(parrafos[max(0, i - 3):i])[-500:]
            if i < len(parrafos) - 1:
                cuerpo["next_text"] = "\n\n".join(parrafos[i + 1:i + 4])[:500]
            guardado.write_bytes(solo_audio(pedir_elevenlabs(f"text-to-speech/{voz}", cuerpo)))
            nuevos += 1
            print(f"\r    párrafo {i + 1}/{len(parrafos)}", end="", flush=True)
        audio += guardado.read_bytes()
        tras_parrafo = True
        i += 1
    print(f"\r    {nuevos} párrafos generados, {len(parrafos) - nuevos} reutilizados")
    return audio


def ffmpeg(*args):
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", *args], check=True)


def duracion_de(fichero):
    orden = ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(fichero)]
    return float(subprocess.run(orden, capture_output=True, text=True, check=True).stdout)


def bucle_de_fondo(m, forzar=False):
    """Fichero WAV con el fondo de la meditación, listo para repetirse sin que se note la costura."""
    (CACHE / "fondo").mkdir(parents=True, exist_ok=True)
    base = CACHE / "fondo" / huella_de(m["fondo_tipo"], m["fondo"])
    original, bucle = base.with_suffix(".mp3"), base.with_suffix(".wav")
    if not original.exists() or forzar:
        print("    generando fondo…")
        if m["fondo_tipo"] == "ambiente":
            cuerpo = {"text": m["fondo"], "loop": True, "duration_seconds": AMBIENTE_S}
            original.write_bytes(pedir_elevenlabs("sound-generation", cuerpo))
        else:
            cuerpo = {"prompt": m["fondo"], "music_length_ms": MUSICA_S * 1000, "force_instrumental": True}
            original.write_bytes(pedir_elevenlabs("music", cuerpo))
        bucle.unlink(missing_ok=True)
    if not bucle.exists():
        # El final del bucle se funde con el principio del original, de modo que al repetirse
        # enlaza con el punto exacto en el que empezó.
        d = min(5, duracion_de(original) / 4)
        ffmpeg(
            "-i", str(original),
            "-filter_complex",
            f"[0]atrim=start={d},asetpts=PTS-STARTPTS[cuerpo];[0]atrim=end={d},asetpts=PTS-STARTPTS[inicio];"
            f"[cuerpo][inicio]acrossfade=d={d}:c1=tri:c2=tri",
            "-ar", str(HZ), "-ac", "2", str(bucle),
        )
    return bucle


def mezclar(voz, bucle, volumen):
    """Devuelve el MP3 final y su duración. Sin fondo, la voz sola recodificada."""
    duracion = len(voz) * 8 / (KBPS * 1000)
    with tempfile.TemporaryDirectory() as tmp:
        entrada, salida = Path(tmp) / "voz.mp3", Path(tmp) / "final.mp3"
        entrada.write_bytes(voz)
        codificar = ["-ar", str(HZ), "-b:a", f"{KBPS_FINAL}k", "-write_xing", "1"]
        if bucle:
            duracion += ENTRADA + SALIDA
            estereo = "aformat=sample_rates=44100:channel_layouts=stereo"
            ffmpeg(
                "-i", str(entrada), "-stream_loop", "-1", "-i", str(bucle),
                "-filter_complex",
                f"[0]{estereo},adelay={ENTRADA * 1000}:all=1,apad[voz];"
                f"[1]{estereo},volume={volumen},afade=t=in:d={ENTRADA},"
                f"afade=t=out:st={duracion - SALIDA + 2}:d={SALIDA - 2}[fondo];"
                "[voz][fondo]amix=inputs=2:duration=longest:normalize=0",
                "-t", f"{duracion:.3f}", *codificar, str(salida),
            )
        else:
            ffmpeg("-i", str(entrada), "-ac", "1", *codificar, str(salida))
        return salida.read_bytes(), duracion


def ajustes_de_voz():
    return os.environ["ELEVENLABS_VOICE_ID"], os.environ.get("ELEVENLABS_MODEL", MODELO)


def producir(m, forzar):
    print(f"  generando     {m['usuario']}/{m['slug']}…")
    voz = voz_elevenlabs(m["texto"], *ajustes_de_voz(), forzar)
    bucle = bucle_de_fondo(m, forzar) if m["fondo"] else None
    return mezclar(voz, bucle, m["volumen_fondo"])


def escuchar(meditaciones, forzar):
    cargar_env("ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID")
    for m in meditaciones:
        audio, duracion = producir(m, forzar)
        destino = ESCUCHA / m["usuario"] / f"{m['slug']}.mp3"
        destino.parent.mkdir(parents=True, exist_ok=True)
        destino.write_bytes(audio)
        print(f"  {round(duracion / 60, 1)} min → {destino.relative_to(RAIZ)}")


def publicar(meditaciones, forzar):
    cargar_env("ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID", "SUPABASE_URL", "SUPABASE_SECRET_KEY")
    supa = Supabase()
    ids, publicadas = {}, {}
    for usuario in sorted({m["usuario"] for m in meditaciones}):
        ids[usuario] = supa.id_de(usuario)
        if not ids[usuario]:
            sys.exit(f"No existe el usuario «{usuario}». Créalo con: python3 herramientas/crear_usuario.py {usuario}")
        publicadas[usuario] = supa.publicadas(ids[usuario])

    for m in meditaciones:
        nombre, id_usuario = f"{m['usuario']}/{m['slug']}", ids[m["usuario"]]
        # La huella incluye todo lo que cambia el audio: tocar cualquier ajuste lo regenera.
        huella = huella_de(
            *ajustes_de_voz(), PAUSA, ENTRADA, SALIDA, KBPS_FINAL,
            m["fondo_tipo"], m["fondo"], m["volumen_fondo"], m["texto"], largo=12,
        )
        datos = {"titulo": m["titulo"], "descripcion": m["descripcion"], "orden": m["orden"]}
        anterior = publicadas[m["usuario"]].get(m["slug"])
        if anterior and anterior["texto_hash"] == huella and not forzar:
            supa.actualizar(id_usuario, m["slug"], datos)
            print(f"  sin cambios   {nombre}")
            continue
        audio, duracion = producir(m, forzar)
        ruta = f"{id_usuario}/{m['slug']}-{huella}.mp3"
        supa.subir_audio(ruta, audio)
        supa.guardar({
            **datos,
            "user_id": id_usuario,
            "slug": m["slug"],
            "texto": m["texto"],
            "texto_hash": huella,
            "audio_ruta": ruta,
            "duracion_s": round(duracion),
        })
        if anterior and anterior["audio_ruta"] != ruta:
            supa.borrar_audio(anterior["audio_ruta"])
        print(f"  publicada     {nombre}")


def borrar(nombre):
    usuario, _, slug = nombre.partition("/")
    cargar_env("SUPABASE_URL", "SUPABASE_SECRET_KEY")
    supa = Supabase()
    id_usuario = supa.id_de(usuario)
    fila = supa.publicadas(id_usuario).get(slug) if id_usuario else None
    if not fila:
        sys.exit(f"No hay ninguna meditación publicada como «{nombre}» (se escribe usuario/fichero-sin-extensión).")
    supa.borrar(id_usuario, fila)
    print(f"  borrada       {nombre}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("ficheros", nargs="*", type=Path, help="meditaciones concretas; por defecto, todas")
    parser.add_argument("--escuchar", action="store_true", help="genera el audio en escucha/ sin subir nada")
    parser.add_argument("--forzar", action="store_true", help="regenera la voz y el fondo aunque no hayan cambiado")
    parser.add_argument("--borrar", metavar="USUARIO/MEDITACION", help="retira una meditación de la app")
    args = parser.parse_args()

    if args.borrar:
        return borrar(args.borrar)
    rutas = [f.resolve() for f in args.ficheros] or MEDITACIONES.glob("*/*.md")
    meditaciones = sorted((leer_meditacion(r) for r in rutas), key=lambda m: (m["usuario"], m["orden"], m["slug"]))
    if not meditaciones:
        sys.exit("No hay meditaciones en meditaciones/<usuario>/*.md")
    print(f"{len(meditaciones)} meditaciones encontradas")
    escuchar(meditaciones, args.forzar) if args.escuchar else publicar(meditaciones, args.forzar)


if __name__ == "__main__":
    main()
