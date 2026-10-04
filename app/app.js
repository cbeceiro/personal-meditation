const CFG = window.CONFIG;
const DOMINIO = 't-med.app'; // el usuario se guarda en Supabase como usuario@DOMINIO; igual que en herramientas/comun.py
const BUCKET = 'meditaciones-audio';
const CACHE_AUDIO = 'audio-v1';
const $ = (id) => document.getElementById(id);
const audio = $('audio');

const leer = (clave, defecto) => {
  try { return JSON.parse(localStorage.getItem(clave)) ?? defecto; } catch { return defecto; }
};
const guardar = (clave, valor) => {
  try { localStorage.setItem(clave, JSON.stringify(valor)); } catch { /* sin almacenamiento */ }
};

let sesion = leer('sesion', null);
let meditaciones = [];
let actual = null;
const posiciones = leer('posiciones', {});
const descargadas = new Set();
const descargas = new Map(); // descargas en curso, para no pedir dos veces el mismo audio

const mmss = (s) => {
  s = Math.max(0, Math.round(s || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// --- Sesión ---

// Un error «rechazada» significa que Supabase no acepta las credenciales; cualquier otro, que no hay conexión.
async function pedirSesion(tipo, cuerpo) {
  const r = await fetch(`${CFG.supabaseUrl}/auth/v1/token?grant_type=${tipo}`, {
    method: 'POST',
    headers: { apikey: CFG.supabaseKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo),
  });
  if (!r.ok) throw Object.assign(new Error(r.status), { rechazada: r.status < 500 && r.status !== 429 });
  const { access_token, refresh_token, expires_at } = await r.json();
  sesion = { access_token, refresh_token, expires_at };
  guardar('sesion', sesion);
}

// El token de acceso dura una hora; el de renovación solo vale una vez, así que no se renueva en paralelo.
let renovando = null;
async function token() {
  if (sesion.expires_at - 60 < Date.now() / 1000) {
    renovando ??= pedirSesion('refresh_token', { refresh_token: sesion.refresh_token })
      .finally(() => { renovando = null; });
    await renovando;
  }
  return sesion.access_token;
}

async function pedir(ruta) {
  const r = await fetch(`${CFG.supabaseUrl}${ruta}`, {
    headers: { apikey: CFG.supabaseKey, Authorization: `Bearer ${await token()}` },
  });
  if (r.status === 401) throw Object.assign(new Error(401), { rechazada: true });
  if (!r.ok) throw new Error(r.status);
  return r;
}

function mostrarAcceso(mensaje = '') {
  $('acceso').hidden = false;
  $('salir').hidden = true;
  $('estado').textContent = mensaje;
}

// Al salir no queda nada del usuario en el dispositivo: ni sesión, ni catálogo, ni audios.
async function cerrarSesion(mensaje) {
  if (sesion) {
    fetch(`${CFG.supabaseUrl}/auth/v1/logout?scope=local`, {
      method: 'POST',
      headers: { apikey: CFG.supabaseKey, Authorization: `Bearer ${sesion.access_token}` },
      keepalive: true,
    }).catch(() => {});
  }
  try { localStorage.clear(); } catch { /* sin almacenamiento */ }
  await caches.delete(CACHE_AUDIO).catch(() => {});
  if (mensaje) try { sessionStorage.setItem('aviso', mensaje); } catch { /* sin almacenamiento */ }
  location.reload();
}

$('acceso').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('entrar').disabled = true;
  $('estado').textContent = '';
  try {
    const usuario = $('usuario').value.trim().toLowerCase();
    await pedirSesion('password', { email: `${usuario}@${DOMINIO}`, password: $('clave').value });
    $('clave').value = '';
    $('acceso').hidden = true;
    iniciar();
  } catch (err) {
    $('estado').textContent = err.rechazada
      ? 'Usuario o contraseña incorrectos.'
      : 'No se ha podido entrar. Revisa la conexión.';
  } finally {
    $('entrar').disabled = false;
  }
});

$('salir').addEventListener('click', () => cerrarSesion());

// --- Catálogo y audios ---

async function cargarCatalogo() {
  let alDia = false;
  try {
    const r = await pedir('/rest/v1/meditaciones?select=slug,titulo,descripcion,audio_ruta,duracion_s&order=orden,titulo');
    meditaciones = await r.json();
    guardar('catalogo', meditaciones);
    alDia = true;
    $('estado').textContent = meditaciones.length ? '' : 'Todavía no tienes meditaciones.';
  } catch (err) {
    if (err.rechazada) return cerrarSesion('La sesión ha caducado. Vuelve a entrar.');
    meditaciones = leer('catalogo', []);
    $('estado').textContent = meditaciones.length
      ? 'Sin conexión: se muestran las meditaciones ya guardadas.'
      : 'No se han podido cargar las meditaciones. Revisa la conexión.';
  }
  pintarLista();
  descargarAudios(alDia);
}

function pintarLista() {
  $('lista').replaceChildren(...meditaciones.map((m) => {
    const li = document.createElement('li');
    const boton = document.createElement('button');
    boton.className = 'meditacion';
    boton.setAttribute('aria-current', String(actual?.slug === m.slug));
    const titulo = document.createElement('strong');
    titulo.textContent = m.titulo;
    const desc = document.createElement('span');
    desc.textContent = m.descripcion;
    const meta = document.createElement('small');
    const partes = [];
    if (m.duracion_s) partes.push(`${Math.max(1, Math.round(m.duracion_s / 60))} min`);
    if (posiciones[m.slug] > 5) partes.push(`seguir desde ${mmss(posiciones[m.slug])}`);
    if (descargadas.has(m.audio_ruta)) partes.push('✓ sin conexión');
    meta.textContent = partes.join(' · ');
    boton.append(titulo, desc, meta);
    boton.addEventListener('click', () => abrir(m));
    li.append(boton);
    return li;
  }));
}

// Los audios son privados y un <audio> no puede enviar el token, así que se descargan con él,
// se guardan en el dispositivo y se reproducen desde ahí. De paso funcionan sin conexión.
function descargar(m) {
  if (!descargas.has(m.audio_ruta)) {
    const descarga = (async () => {
      const cache = await caches.open(CACHE_AUDIO);
      let guardado = await cache.match(m.audio_ruta);
      if (!guardado) {
        const r = await pedir(`/storage/v1/object/authenticated/${BUCKET}/${m.audio_ruta}`);
        await cache.put(m.audio_ruta, r);
        guardado = await cache.match(m.audio_ruta);
      }
      descargadas.add(m.audio_ruta);
      pintarLista();
      return guardado.blob();
    })();
    descargas.set(m.audio_ruta, descarga);
    descarga.catch(() => descargas.delete(m.audio_ruta));
  }
  return descargas.get(m.audio_ruta);
}

async function descargarAudios(alDia) {
  if (alDia) {
    // Con el catálogo recién leído se retiran los audios de meditaciones borradas o regeneradas.
    const cache = await caches.open(CACHE_AUDIO);
    const vigentes = new Set(meditaciones.map((m) => new URL(m.audio_ruta, location.href).href));
    for (const peticion of await cache.keys()) {
      if (!vigentes.has(peticion.url)) await cache.delete(peticion);
    }
  }
  for (const m of meditaciones) {
    await descargar(m).catch(() => { /* se reintentará en la próxima apertura */ });
  }
}

// --- Reproductor ---

async function abrir(meditacion, { reproducir = true } = {}) {
  if (actual?.slug === meditacion.slug) {
    if (reproducir && audio.paused) audio.play().catch(() => {});
    return;
  }
  actual = meditacion;
  guardar('ultima', meditacion.slug);
  audio.pause();
  $('titulo-actual').textContent = meditacion.titulo;
  $('reproductor').hidden = false;
  document.body.classList.add('con-reproductor');
  pintarLista();

  let blob;
  try {
    if (!descargadas.has(meditacion.audio_ruta)) $('estado').textContent = `Descargando «${meditacion.titulo}»…`;
    blob = await descargar(meditacion);
    $('estado').textContent = '';
  } catch (err) {
    if (err.rechazada) return cerrarSesion('La sesión ha caducado. Vuelve a entrar.');
    $('estado').textContent = `No se ha podido descargar «${meditacion.titulo}». Revisa la conexión.`;
    return;
  }
  if (actual !== meditacion) return; // se ha elegido otra mientras se descargaba

  const pos = posiciones[meditacion.slug] || 0;
  if (audio.src) URL.revokeObjectURL(audio.src);
  audio.src = URL.createObjectURL(blob);
  audio.addEventListener('loadedmetadata', () => {
    if (pos > 5 && pos < audio.duration - 10) audio.currentTime = pos;
  }, { once: true });
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: meditacion.titulo,
      artist: 'T-med',
      artwork: [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
    });
  }
  pintarProgreso();
  if (reproducir) audio.play().catch(() => {});
}

function saltar(segundos) {
  audio.currentTime = Math.min(Math.max(0, audio.currentTime + segundos), audio.duration || 0);
}

function pintarProgreso() {
  const total = audio.duration || actual?.duracion_s || 0;
  $('progreso').max = Math.floor(total) || 100;
  $('progreso').value = Math.floor(audio.currentTime);
  $('transcurrido').textContent = mmss(audio.currentTime);
  $('restante').textContent = `-${mmss(total - audio.currentTime)}`;
}

let ultimoGuardado = 0;
audio.addEventListener('timeupdate', () => {
  pintarProgreso();
  if (actual && Math.abs(audio.currentTime - ultimoGuardado) >= 5) {
    ultimoGuardado = audio.currentTime;
    posiciones[actual.slug] = audio.currentTime;
    guardar('posiciones', posiciones);
  }
});
audio.addEventListener('play', () => {
  $('play').textContent = '❚❚';
  $('play').setAttribute('aria-label', 'Pausar');
});
audio.addEventListener('pause', () => {
  $('play').textContent = '▶';
  $('play').setAttribute('aria-label', 'Reproducir');
});
audio.addEventListener('ended', () => {
  delete posiciones[actual.slug];
  guardar('posiciones', posiciones);
  pintarLista();
});
audio.addEventListener('error', () => {
  if (actual) $('estado').textContent = `No se ha podido reproducir «${actual.titulo}».`;
});

$('play').addEventListener('click', () => (audio.paused ? audio.play().catch(() => {}) : audio.pause()));
$('atras').addEventListener('click', () => saltar(-15));
$('adelante').addEventListener('click', () => saltar(15));
$('progreso').addEventListener('input', (e) => { audio.currentTime = Number(e.target.value); });

if ('mediaSession' in navigator) {
  const acciones = {
    play: () => audio.play(),
    pause: () => audio.pause(),
    seekbackward: () => saltar(-15),
    seekforward: () => saltar(15),
  };
  for (const [accion, manejador] of Object.entries(acciones)) {
    try { navigator.mediaSession.setActionHandler(accion, manejador); } catch { /* acción no soportada */ }
  }
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');

async function iniciar() {
  $('salir').hidden = false;
  await cargarCatalogo();
  const ultima = meditaciones.find((m) => m.slug === leer('ultima', null));
  if (ultima && posiciones[ultima.slug] > 5) abrir(ultima, { reproducir: false });
}

if (sesion) {
  iniciar();
} else {
  let aviso = '';
  try { aviso = sessionStorage.getItem('aviso') || ''; sessionStorage.removeItem('aviso'); } catch { /* sin almacenamiento */ }
  mostrarAcceso(aviso);
}
