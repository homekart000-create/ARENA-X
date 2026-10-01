const CACHE_NAME = 'arena-x-shell-v1';
const SHELL_FILES = [
  './css/style.css',
  './js/pwa.js',
  './manifest.webmanifest'
];
const scopeUrl = new URL(self.registration.scope);
const shellPaths = new Set(SHELL_FILES.map((file) => new URL(file, scopeUrl).pathname));
const offlineDocument = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#10120f">
  <title>Offline | ARENA-X</title>
  <style>
    :root { color-scheme: dark; font-family: 'Segoe UI', Tahoma, sans-serif; color: #f0f1e8; background: #10120f; }
    body { min-height: 100vh; display: grid; place-items: center; margin: 0; padding: 24px; box-sizing: border-box; }
    main { width: min(100%, 440px); border-left: 3px solid #d2fa47; padding: 8px 0 8px 22px; }
    p { color: #d2fa47; font-size: 12px; font-weight: 700; letter-spacing: 1px; }
    h1 { margin: 0; font-size: clamp(30px, 8vw, 46px); line-height: 1; }
    a { display: inline-block; margin-top: 18px; color: #d2fa47; }
  </style>
</head>
<body>
  <main>
    <p>CONNECTION REQUIRED</p>
    <h1>ARENA-X is offline.</h1>
    <a href="./">Try again</a>
  </main>
</body>
</html>`;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const cacheNames = await caches.keys();
    await Promise.all(cacheNames
      .filter((name) => name.startsWith('arena-x-shell-') && name !== CACHE_NAME)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const requestUrl = new URL(request.url);
  if (requestUrl.origin !== self.location.origin || !requestUrl.pathname.startsWith(scopeUrl.pathname)) return;

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => new Response(offlineDocument, {
      status: 503,
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    })));
    return;
  }

  if (!shellPaths.has(requestUrl.pathname)) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      const response = await fetch(request);
      if (response.ok) await cache.put(request, response.clone());
      return response;
    } catch {
      return await cache.match(request, { ignoreSearch: true }) || new Response('ARENA-X static resources are unavailable offline.', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    }
  })());
});
