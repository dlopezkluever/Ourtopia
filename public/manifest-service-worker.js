/* global self, caches, fetch, URL */
const shellCache = 'ourtopia-public-shell-v1';
const shellPaths = ['/manifest-offline.html', '/manifest.webmanifest', '/manifest-icon.png', '/manifest-icon-512.png'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(shellCache).then(cache => cache.addAll(shellPaths)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('ourtopia-public-shell-') && key !== shellCache).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(() => caches.match('/manifest-offline.html')));
  } else if (!url.search && shellPaths.includes(url.pathname)) {
    event.respondWith(caches.match(url.pathname).then(cached => cached || fetch(event.request)));
  }
});
