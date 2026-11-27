/* ============================================================
   Service Worker del Emulador GBA — jugar sin internet.
   Ámbito: /emulador-gba/ (este archivo vive en la raíz del repo).

   Para qué sirve: la app de la Sala en Android carga la página en
   vivo (https://thedecro3312-ux.github.io/emulador-gba/). Sin
   internet, este SW sirve la página desde la caché BAJO ESE MISMO
   ORIGEN https, así que la biblioteca de ROMs (IndexedDB) y los
   ajustes (localStorage) son los mismos que en línea. Sin el SW, la
   app cae a la copia local file://, que es otro origen con la
   biblioteca vacía.

   Qué se cachea: solo archivos del mismo origen (la página, el motor
   EmulatorJS vendorizado, PeerJS y el DualPlayer). NUNCA se cachea
   nada externo: Google Fonts y cualquier otro origen pasan de largo
   (si no hay red, simplemente no cargan; no rompen nada).

   IMPORTANTE — actualizaciones: la navegación se sirve desde la
   caché primero y se refresca en segundo plano, así que una versión
   nueva llega sola cuando hay internet. PERO si se publica un
   index.html o un asset nuevo, hay que subir el número de CACHE
   (v1 -> v2...) en este archivo: el cambio de bytes en sw.js es lo
   que despierta al SW viejo y le hace instalar la caché nueva. Si
   no se sube, el SW seguiría sirviendo la versión vieja.
   ============================================================ */

var CACHE = 'emulador-gba-v1';

var CORE = [
  './',
  './index.html',
  './assets/ejs/loader.js',
  './assets/ejs/emulator.min.js',
  './assets/ejs/emulator.min.css',
  './assets/ejs/cores/mgba-wasm.data',
  './assets/ejs/cores/mgba-legacy-wasm.data',
  './assets/ejs/cores/reports/mgba.json',
  './assets/ejs/compression/extract7z.js',
  './assets/ejs/compression/extractzip.js',
  './assets/ejs/compression/libunrar.js',
  './assets/ejs/compression/libunrar.wasm',
  './assets/ejs/localization/es-ES.json',
  './assets/peerjs.min.js',
  './assets/dual/dual-player.js'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE)
      .then(function (cache) { return cache.addAll(CORE); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

/* Refresca una entrada en segundo plano (sin frenar la respuesta). */
function refreshInBackground(request, cacheKey) {
  return fetch(request).then(function (res) {
    if (res && res.ok) {
      return caches.open(CACHE).then(function (cache) {
        return cache.put(cacheKey || request, res.clone());
      });
    }
  }).catch(function () { /* sin red: la caché sigue valiendo */ });
}

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  /* Solo mismo origen: lo externo (Google Fonts, etc.) no se toca
     ni se cachea jamás. */
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    /* Navegación: primero la caché (funciona sin red), y en segundo
       plano se refresca para que la próxima versión llegue sola. */
    event.respondWith(
      caches.match('./index.html', { ignoreSearch: true }).then(function (hit) {
        if (hit) {
          event.waitUntil(refreshInBackground(req, './index.html'));
          return hit;
        }
        return fetch(req).then(function (res) {
          if (res && res.ok) {
            var copy = res.clone();
            caches.open(CACHE).then(function (cache) {
              cache.put('./index.html', copy);
            });
          }
          return res;
        });
      }).catch(function () { return caches.match('./index.html'); })
    );
    return;
  }

  /* Resto de recursos del mismo origen: caché primero, con refresco
     en segundo plano cuando hay red. */
  event.respondWith(
    caches.match(req).then(function (hit) {
      if (hit) {
        event.waitUntil(refreshInBackground(req));
        return hit;
      }
      return fetch(req).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(CACHE).then(function (cache) {
            cache.put(req, copy);
          });
        }
        return res;
      });
    })
  );
});
