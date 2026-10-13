// Sow service worker: app shell offline, everything else from the network.
var C = 'sow-v9', SHELL = ['/', '/index.html', '/styles.css?v=9', '/app.js?v=9', '/vendor/supabase.js', '/manifest.webmanifest', '/icons/icon-192.png'];
self.addEventListener('install', function (e) { e.waitUntil(caches.open(C).then(function (c) { return c.addAll(SHELL); })); self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(caches.keys().then(function (ks) { return Promise.all(ks.filter(function (k) { return k !== C; }).map(function (k) { return caches.delete(k); })); })); self.clients.claim(); });
self.addEventListener('fetch', function (e) {
  var u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.indexOf('/api/') === 0) return;
  e.respondWith(fetch(e.request).then(function (r) { var cp = r.clone(); caches.open(C).then(function (c) { c.put(e.request, cp); }); return r; })
    .catch(function () { return caches.match(e.request).then(function (r) { return r || caches.match('/index.html'); }); }));
});
