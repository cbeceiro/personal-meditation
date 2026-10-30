const CFG = window.CONFIG;
const DOMINIO = 't-med.app'; // el usuario se guarda en Supabase como usuario@DOMINIO; igual que en herramientas/comun.py
const BUCKET = 'meditaciones-audio';
const CACHE_AUDIO = 'audio-v1';
const SILENCIO = 240; // segundos de solo fondo antes del cierre y duración del cierre, como en publicar.py;
const CIERRE = 60; // se usan solo con meditaciones publicadas antes de guardar sus marcas
const REPOSO_MS = 5000; // tras este tiempo sonando sin tocar nada, los controles se ocultan y la pantalla se oscurece
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
const minutos = (s) => `${Math.max(1, Math.round(s / 60))} min`;

// Cada meditación tiene su color, sacado de su nombre para que no cambie entre aperturas.
const tono = (slug) => {
  let h = 0;
  for (const c of slug) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
};

function crear(etiqueta, clase, texto) {
  const el = document.createElement(etiqueta);
  if (clase) el.className = clase;
  if (texto) el.textContent = texto;
  return el;
}

let temporizadorAviso;
function avisar(texto) {
  $('aviso').textContent = texto;
  $('aviso').hidden = false;
  clearTimeout(temporizadorAviso);
  temporizadorAviso = setTimeout(() => { $('aviso').hidden = true; }, 4500);
}

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
  $('inicio').hidden = true;
  $('error-acceso').textContent = mensaje;
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
  $('error-acceso').textContent = '';
  try {
    const usuario = $('usuario').value.trim().toLowerCase();
    await pedirSesion('password', { email: `${usuario}@${DOMINIO}`, password: $('clave').value });
    guardar('usuario', usuario);
    $('clave').value = '';
    $('acceso').hidden = true;
    iniciar();
  } catch (err) {
    $('error-acceso').textContent = err.rechazada
      ? 'Usuario o contraseña incorrectos.'
      : 'No se ha podido entrar. Revisa la conexión.';
  } finally {
    $('entrar').disabled = false;
  }
});

$('salir').addEventListener('click', () => cerrarSesion());

// --- Inicio ---

function pintarSaludo() {
  const hora = new Date().getHours();
  const saludo = hora < 6 || hora >= 21 ? 'Buenas noches' : hora < 13 ? 'Buenos días' : 'Buenas tardes';
  const usuario = leer('usuario', '');
  const nombre = usuario && usuario[0].toUpperCase() + usuario.slice(1);
  $('saludo').textContent = nombre ? `${saludo}, ${nombre}` : saludo;
  $('momento').textContent = new Date().toLocaleDateString('es', { weekday: 'long', day: 'numeric', month: 'long' });
}

// Se destaca la que está sonando o quedó a medias o, si no, la siguiente a la última escuchada.
function elegirDestacada() {
  if (actual) return { m: actual, seguir: true };
  const ultima = meditaciones.findIndex((m) => m.slug === leer('ultima', null));
  if (ultima >= 0 && posiciones[meditaciones[ultima].slug] > 5) return { m: meditaciones[ultima], seguir: true };
  return { m: meditaciones[(ultima + 1) % meditaciones.length], seguir: false };
}

function pintarDestacada() {
  if (!meditaciones.length) return $('destacada').replaceChildren();
  const { m, seguir } = elegirDestacada();
  const boton = crear('button', 'destacada');
  boton.style.setProperty('--tono', tono(m.slug));
  const pie = crear('span', 'pie');
  const pos = posiciones[m.slug] || 0;
  pie.append(
    crear('span', 'boton-play'),
    crear('span', '', seguir && pos ? `Quedan ${minutos((m.duracion_s || 0) - pos)}` : m.duracion_s ? minutos(m.duracion_s) : ''),
  );
  boton.append(
    crear('span', 'orbe-destacada'),
    crear('span', 'etiqueta', seguir ? 'Seguir donde lo dejaste' : 'Para hoy'),
    crear('strong', '', m.titulo),
    crear('span', 'desc', m.descripcion),
    pie,
  );
  boton.setAttribute('aria-label', `${seguir ? 'Seguir' : 'Empezar'} ${m.titulo}`);
  boton.addEventListener('click', () => abrir(m));
  $('destacada').replaceChildren(boton);
}

const ICONO_OFFLINE = '<svg class="offline" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9.5"/></svg>';

function pintarLista() {
  pintarDestacada();
  $('titulo-lista').hidden = meditaciones.length < 2;
  $('lista').replaceChildren(...(meditaciones.length < 2 ? [] : meditaciones).map((m) => {
    const li = crear('li');
    const boton = crear('button', 'meditacion');
    boton.setAttribute('aria-current', String(actual?.slug === m.slug));
    const orbe = crear('span', 'orbe-lista');
    orbe.style.setProperty('--tono', tono(m.slug));
    const textos = crear('span', 'textos');
    const meta = crear('small');
    if (m.duracion_s) meta.append(minutos(m.duracion_s));
    if (posiciones[m.slug] > 5) meta.append(' · ', crear('span', 'seguir', `seguir desde ${mmss(posiciones[m.slug])}`));
    if (descargadas.has(m.audio_ruta)) {
      meta.insertAdjacentHTML('beforeend', ICONO_OFFLINE);
      meta.title = 'Disponible sin conexión';
    }
    textos.append(crear('strong', '', m.titulo), crear('span', 'desc', m.descripcion), meta);
    boton.append(orbe, textos);
    boton.addEventListener('click', () => abrir(m));
    li.append(boton);
    return li;
  }));
}

// --- Catálogo y audios ---

async function cargarCatalogo() {
  let alDia = false;
  try {
    const r = await pedir('/rest/v1/meditaciones?select=slug,titulo,descripcion,audio_ruta,duracion_s,marcas&order=orden,titulo');
    meditaciones = await r.json();
    guardar('catalogo', meditaciones);
    alDia = true;
    $('estado').textContent = meditaciones.length ? '' : 'Todavía no tienes meditaciones.';
  } catch (err) {
    if (err.rechazada) return cerrarSesion('La sesión ha caducado. Vuelve a entrar.');
    meditaciones = leer('catalogo', []);
    $('estado').textContent = meditaciones.length
      ? 'Sin conexión: tienes a mano las meditaciones ya guardadas.'
      : 'No se han podido cargar las meditaciones. Revisa la conexión.';
  }
  pintarLista();
  descargarAudios(alDia);
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

// --- Tramos: meditación guiada, silencio y cierre ---

const duracion = () => audio.duration || actual?.duracion_s || 0;

function tramos() {
  const total = duracion();
  const marcas = actual?.marcas;
  const cierre = Math.min(marcas?.cierre ?? total - CIERRE, total);
  const silencio = Math.min(marcas?.silencio ?? cierre - SILENCIO, cierre);
  return [
    { nombre: 'Meditación guiada', desde: 0, hasta: Math.max(0, silencio) },
    { nombre: 'Silencio', desde: Math.max(0, silencio), hasta: Math.max(0, cierre) },
    { nombre: 'Cierre', desde: Math.max(0, cierre), hasta: total },
  ].filter((t) => t.hasta - t.desde > 1);
}

// El anillo es una circunferencia partida en un arco por tramo; cada arco se rellena a su ritmo.
const RADIO = 96;
const CIRCUNFERENCIA = 2 * Math.PI * RADIO;
const HUECO = 6;
let arcos = [];

function arco(clase, desde, largo) {
  const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  c.setAttribute('cx', 100);
  c.setAttribute('cy', 100);
  c.setAttribute('r', RADIO);
  if (clase) c.setAttribute('class', clase);
  c.setAttribute('stroke-dasharray', `${largo} ${CIRCUNFERENCIA}`);
  c.setAttribute('stroke-dashoffset', -desde);
  return c;
}

function dibujarAnillo() {
  const total = duracion();
  const lista = total ? tramos() : [];
  const hueco = lista.length > 1 ? HUECO : 0;
  arcos = lista.map((t) => ({
    ...t,
    inicio: (t.desde / total) * CIRCUNFERENCIA + hueco / 2,
    largo: Math.max(0, ((t.hasta - t.desde) / total) * CIRCUNFERENCIA - hueco),
  }));
  $('pistas').replaceChildren(...arcos.map((a) => arco('', a.inicio, a.largo)));
  $('rellenos').replaceChildren(...arcos.map((a) => (a.relleno = arco('', a.inicio, 0))));
}

// --- Reproductor ---

function mostrarReproductor() {
  $('reproductor').hidden = false;
  $('mini').hidden = true;
  document.body.classList.add('con-reproductor');
  document.body.classList.remove('con-mini');
  despertar();
}

function ocultarReproductor() {
  if (!$('final').hidden) return terminar();
  $('reproductor').hidden = true;
  document.body.classList.remove('con-reproductor');
  clearTimeout(temporizadorReposo);
  $('mini').hidden = !actual;
  document.body.classList.toggle('con-mini', Boolean(actual));
  pintarLista();
}

// Tras la pantalla final no queda nada a medias: se vuelve al inicio sin reproductor.
function terminar() {
  actual = null;
  audio.removeAttribute('src');
  audio.load();
  $('final').hidden = true;
  $('reproductor').hidden = true;
  $('mini').hidden = true;
  document.body.classList.remove('con-reproductor', 'con-mini');
  pintarLista();
}

async function abrir(meditacion, { reproducir = true, mostrar = true } = {}) {
  if (mostrar) mostrarReproductor();
  if (actual?.slug === meditacion.slug) {
    if (reproducir && audio.paused) audio.play().catch(() => {});
    return;
  }
  actual = meditacion;
  guardar('ultima', meditacion.slug);
  audio.pause();
  $('final').hidden = true;
  for (const el of [$('reproductor'), $('mini')]) el.style.setProperty('--tono', tono(meditacion.slug));
  $('mini').querySelector('.orbe-mini').style.setProperty('--tono', tono(meditacion.slug));
  $('titulo-actual').textContent = meditacion.titulo;
  $('mini-titulo').textContent = meditacion.titulo;
  pintarLista();
  pintarProgreso();

  let blob;
  try {
    if (!descargadas.has(meditacion.audio_ruta)) $('tramo').textContent = 'Preparando…';
    blob = await descargar(meditacion);
  } catch (err) {
    if (err.rechazada) return cerrarSesion('La sesión ha caducado. Vuelve a entrar.');
    $('tramo').textContent = '';
    avisar(`No se ha podido descargar «${meditacion.titulo}». Revisa la conexión.`);
    return;
  }
  if (actual !== meditacion) return; // se ha elegido otra mientras se descargaba

  const pos = posiciones[meditacion.slug] || 0;
  if (audio.src) URL.revokeObjectURL(audio.src);
  audio.src = URL.createObjectURL(blob);
  audio.addEventListener('loadedmetadata', () => {
    if (pos > 5 && pos < audio.duration - 10) audio.currentTime = pos;
    dibujarAnillo();
    pintarProgreso();
  }, { once: true });
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: meditacion.titulo,
      artist: 'T-med',
      artwork: [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
    });
  }
  dibujarAnillo();
  pintarProgreso();
  if (reproducir) audio.play().catch(() => {});
}

function saltar(segundos) {
  audio.currentTime = Math.min(Math.max(0, audio.currentTime + segundos), audio.duration || 0);
}

function pintarProgreso() {
  const total = duracion();
  const t = audio.currentTime;
  $('progreso').max = Math.floor(total) || 100;
  $('progreso').value = Math.floor(t);
  $('transcurrido').textContent = mmss(t);
  $('total').textContent = mmss(total);
  const queda = total - t;
  $('restante').textContent = total ? `Quedan ${mmss(queda)}` : '';
  $('mini-tiempo').textContent = total ? `−${mmss(queda)}` : '';

  for (const a of arcos) {
    const parte = Math.min(Math.max((t - a.desde) / (a.hasta - a.desde), 0), 1);
    a.relleno.setAttribute('stroke-dasharray', `${a.largo * parte} ${CIRCUNFERENCIA}`);
  }
  const tramo = arcos.find((a) => t < a.hasta) ?? arcos.at(-1);
  if (tramo) {
    $('tramo').textContent = tramo.nombre;
    $('al-cierre').hidden = tramo.nombre !== 'Silencio';
  }
}

// Tras unos segundos sonando, los controles se apagan; el primer toque los vuelve a mostrar.
let temporizadorReposo;
function despertar() {
  $('reproductor').classList.remove('reposo');
  clearTimeout(temporizadorReposo);
  if (!audio.paused) temporizadorReposo = setTimeout(() => $('reproductor').classList.add('reposo'), REPOSO_MS);
}

$('reproductor').addEventListener('click', (e) => {
  if ($('reproductor').classList.contains('reposo')) {
    e.stopPropagation();
    e.preventDefault();
  }
  despertar();
}, { capture: true });
$('progreso').addEventListener('pointerdown', despertar);

function marcarSonando(sonando) {
  for (const el of [$('reproductor'), $('mini')]) el.classList.toggle('sonando', sonando);
  const etiqueta = sonando ? 'Pausar' : 'Reproducir';
  $('play').setAttribute('aria-label', etiqueta);
  $('mini-play').setAttribute('aria-label', etiqueta);
  despertar();
}

let ultimoGuardado = 0;
audio.addEventListener('timeupdate', () => {
  pintarProgreso();
  if (actual && Math.abs(audio.currentTime - ultimoGuardado) >= 5) {
    ultimoGuardado = audio.currentTime;
    posiciones[actual.slug] = audio.currentTime;
    guardar('posiciones', posiciones);
    if ('mediaSession' in navigator && audio.duration) {
      try {
        navigator.mediaSession.setPositionState({ duration: audio.duration, position: audio.currentTime, playbackRate: 1 });
      } catch { /* no soportado */ }
    }
  }
});
audio.addEventListener('play', () => marcarSonando(true));
audio.addEventListener('pause', () => marcarSonando(false));
audio.addEventListener('ended', () => {
  delete posiciones[actual.slug];
  guardar('posiciones', posiciones);
  $('final').hidden = false;
  mostrarReproductor();
  pintarLista();
});
audio.addEventListener('error', () => {
  if (actual && audio.src) avisar(`No se ha podido reproducir «${actual.titulo}».`);
});

const alternar = () => (audio.paused ? audio.play().catch(() => {}) : audio.pause());
$('play').addEventListener('click', alternar);
$('mini-play').addEventListener('click', (e) => { e.stopPropagation(); alternar(); });
$('mini').addEventListener('click', mostrarReproductor);
$('cerrar').addEventListener('click', ocultarReproductor);
$('atras').addEventListener('click', () => saltar(-15));
$('adelante').addEventListener('click', () => saltar(15));
$('al-cierre').addEventListener('click', () => {
  const cierre = arcos.find((a) => a.nombre === 'Cierre');
  if (cierre) audio.currentTime = cierre.desde;
});
$('progreso').addEventListener('input', (e) => { audio.currentTime = Number(e.target.value); });
$('volver').addEventListener('click', terminar);
document.addEventListener('keydown', (e) => {
  if ($('reproductor').hidden) return;
  if (e.key === 'Escape') ocultarReproductor();
  if (e.key === ' ' && e.target === document.body) { e.preventDefault(); alternar(); }
});

if ('mediaSession' in navigator) {
  const acciones = {
    play: () => audio.play(),
    pause: () => audio.pause(),
    seekbackward: () => saltar(-15),
    seekforward: () => saltar(15),
    seekto: (d) => { audio.currentTime = d.seekTime; },
  };
  for (const [accion, manejador] of Object.entries(acciones)) {
    try { navigator.mediaSession.setActionHandler(accion, manejador); } catch { /* acción no soportada */ }
  }
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');

async function iniciar() {
  $('inicio').hidden = false;
  pintarSaludo();
  await cargarCatalogo();
  const ultima = meditaciones.find((m) => m.slug === leer('ultima', null));
  if (ultima && posiciones[ultima.slug] > 5) {
    abrir(ultima, { reproducir: false, mostrar: false });
    $('mini').hidden = false;
    document.body.classList.add('con-mini');
  }
}

if (sesion) {
  iniciar();
} else {
  let aviso = '';
  try { aviso = sessionStorage.getItem('aviso') || ''; sessionStorage.removeItem('aviso'); } catch { /* sin almacenamiento */ }
  mostrarAcceso(aviso);
}
