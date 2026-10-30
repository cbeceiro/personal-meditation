const SHELL = 'shell-v2';
const FICHEROS = [
  './', 'index.html', 'styles.css', 'app.js', 'config.js', 'manifest.webmanifest',
  'icons/icon-180.png', 'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FICHEROS)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// Solo se ocupa de los ficheros de la app; las peticiones a Supabase pasan sin tocar.
self.addEventListener('fetch', (e) => {
  const propio = new URL(e.request.url).origin === location.origin;
  if (e.request.method === 'GET' && propio) e.respondWith(responder(e.request));
});

// La app se sirve primero de la red para que las actualizaciones lleguen al abrirla;
// la copia guardada solo se usa sin conexión.
async function responder(req) {
  try {
    // 'no-cache' obliga a revalidar con el servidor en lugar de usar la caché HTTP del navegador.
    const r = await fetch(req, { cache: 'no-cache' });
    if (r.status === 200) (await caches.open(SHELL)).put(req, r.clone());
    return r;
  } catch (err) {
    const copia = await caches.match(req, { ignoreSearch: true, cacheName: SHELL });
    if (copia) return copia;
    throw err;
  }
}
