/* global self, caches, fetch, URL, Response */
const shellCache = 'ourtopia-public-shell-v1';
const shellPaths = ['/manifest-offline.html', '/manifest.webmanifest', '/manifest-icon.png', '/manifest-icon-512.png'];
const publicFile = path => caches.open(shellCache).then(cache => cache.match(path));
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
    event.respondWith(fetch(event.request).catch(async () => await publicFile('/manifest-offline.html') || new Response('<!doctype html><html lang="en"><title>Ourtopia unavailable</title><main><h1>Connection unavailable.</h1><p>Reconnect to open your private Community.</p><a href="/">Retry connection</a></main></html>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } })));
  } else if (!url.search && shellPaths.includes(url.pathname)) {
    event.respondWith(publicFile(url.pathname).then(cached => cached || fetch(event.request)));
  }
});
