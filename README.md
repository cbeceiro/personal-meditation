# T-med · Tailored meditations

PWA que reproduce meditaciones personales narradas con una voz clonada sobre un sonido de fondo. Cada persona entra con su usuario y contraseña y solo ve las suyas. Las meditaciones se escriben y se publican desde el ordenador; la app solo las reproduce.

```
meditaciones/<usuario>/*.md  →  herramientas/publicar.py  →  Supabase (tabla meditaciones + bucket privado)  →  app/
```

Los textos no están en este repositorio (`meditaciones/` está en `.gitignore`): viven en el ordenador y, una vez publicados, en la tabla de Supabase.

## Crear un usuario

```bash
python3 herramientas/crear_usuario.py ana
```

Pide la contraseña por teclado. Si el usuario ya existe, ofrece cambiársela. No hay registro ni recuperación de contraseña desde la app.

## Añadir o cambiar una meditación

1. Crea `meditaciones/ana/calma.md` (la carpeta es el nombre de usuario):

   ```markdown
   ---
   titulo: Calma
   descripcion: Una línea que se ve en la lista.
   orden: 1
   fondo: slow warm ambient pad, soft and spacious, no melody, no percussion
   ---

   [softly, slowly] Busca una postura cómoda y cierra los ojos.

   Lleva la atención a la respiración.

   [pausa 30]

   [gently] Poco a poco, vuelve a notar el cuerpo.
   ```

2. Escúchala antes de publicarla (genera `escucha/ana/calma.mp3` sin subir nada):

   ```bash
   python3 herramientas/publicar.py --escuchar meditaciones/ana/calma.md
   ```

3. Publica:

   ```bash
   python3 herramientas/publicar.py
   ```

La voz se genera párrafo a párrafo y se guarda en `.cache/`, así que al retocar un texto solo se paga por los párrafos que cambian. El fondo también se guarda: la misma descripción reutiliza el mismo sonido.

### Formato

- **Párrafos**: separados por una línea en blanco; entre dos párrafos seguidos hay 2 s de silencio.
- **`[pausa N]`**: en una línea propia, N segundos de silencio (el fondo sigue sonando).
- **Etiquetas de estilo**: `[softly]`, `[whispering]`, etc. Las interpreta el modelo de voz.
- **El título no se narra.** El fondo empieza 6 s antes que la voz y se apaga 12 s después.

### Cabecera

| Campo | |
|---|---|
| `titulo`, `descripcion` | Lo que se ve en la lista. |
| `orden` | Posición en la lista. |
| `fondo` | Descripción del sonido de fondo, en inglés. `ninguno` o vacío para dejar solo la voz. |
| `fondo_tipo` | `musica` (por defecto: 3 min de música instrumental en bucle) o `ambiente` (30 s de sonido en bucle: lluvia, olas…). |
| `volumen_fondo` | De 0 a 1; por defecto 0.2. |

## Borrar una meditación

```bash
python3 herramientas/publicar.py --borrar ana/calma
```

Borrar el fichero no retira nada de la app: como los textos solo están en un ordenador, el script nunca borra por su cuenta.

## Configuración (una vez)

- `brew install ffmpeg` y `pip3 install requests`.
- Copia `.env.example` a `.env` y rellena las claves de ElevenLabs y Supabase.
- Aplica `supabase/esquema.sql` en el proyecto de Supabase y desactiva el registro público (Authentication → Sign In / Providers → «Allow new users to sign up»).
- Pon la URL y la clave pública del proyecto en `app/config.js`.
- Activa GitHub Pages con origen «GitHub Actions»: cada push a `main` que toque `app/` la despliega.

## Probar la app en local

```bash
python3 -m http.server 5174 --directory app
```
