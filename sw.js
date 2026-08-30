// sw.js — service worker, strategi cache-first untuk semua asset statis.
// Naikkan CACHE_NAME setiap deploy baru supaya cache lama otomatis dibersihkan.

const CACHE_NAME = 'splitkuy-v14';

const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './js/app.js',
  './lib/xlsx.full.min.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) =>
        // { cache: 'reload' } penting: cache.addAll() biasa masih bisa kena HTTP cache
        // browser yang basi (bukan selalu network fresh), jadi tiap asset di-fetch manual
        // sambil paksa lewati HTTP cache supaya isi Cache Storage service worker selalu
        // sinkron dengan file terbaru saat versi CACHE_NAME naik.
        Promise.all(
          ASSETS_TO_CACHE.map((url) =>
            fetch(url, { cache: 'reload' }).then((response) => cache.put(url, response))
          )
        )
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

// Cache-first: tidak ada API call ke server sama sekali, jadi network-first tidak diperlukan.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((response) => {
          if (response && response.status === 200 && response.type === 'basic') {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => {
          if (event.request.mode === 'navigate') {
            return caches.match('./index.html');
          }
          return undefined;
        });
    })
  );
});
