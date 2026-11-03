/* Task board service worker: lets the app install and open fast.
   It only caches the page's own files. Calls to Google (your tasks) are
   never cached, and the page files are fetched fresh first when online,
   so updates you upload to GitHub show up on the next open. */
var CACHE = 'taskboard-v6';
var FILES = ['./', 'index.html', 'styles.css', 'connect.css', 'connect.js', 'app.js', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png'];

// Save the page files when the app is installed.
self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(FILES); }));
  self.skipWaiting();
});

// Remove caches from older versions.
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }));
  self.clients.claim();
});

// Own files: network first, cached copy when offline. Everything else: not touched.
self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(fetch(e.request).then(function (res) {
    var copy = res.clone();
    caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
    return res;
  }).catch(function () { return caches.match(e.request); }));
});
