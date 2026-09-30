// sw.js
'use strict';

/*
  MasterTech service worker.
  - Cache-first for the app shell (index.html, manifest).
  - Network-first for /api/catalog with 5-minute TTL and offline fallback.
  - Skips caching entirely for /api/admin/* and /api/download/*.
  - Offline fallback: serves the cached index.html for navigation requests.
*/

const VERSION = 'v7-1';
const SHELL_CACHE = 'mastertech-shell-' + VERSION;
const API_CACHE = 'mastertech-api-' + VERSION;
const SHELL_ASSETS = ['/', '/index.html', '/manifest.webmanifest'];

// TTL for cached /api/catalog responses.
const CATALOG_TTL_MS = 5 * 60 * 1000;

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // addAll fails if any URL 404s, so add individually to be resilient.
    await Promise.all(SHELL_ASSETS.map(url =>
      cache.add(url).catch(err => console.info('SW: could not cache', url, err.message))
    ));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => {
      if(k !== SHELL_CACHE && k !== API_CACHE) return caches.delete(k);
    }));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if(req.method !== 'GET') return;

  const url = new URL(req.url);

  // Same-origin only for API caching.
  const isSameOrigin = url.origin === self.location.origin;
  const isAdminApi = isSameOrigin && url.pathname.startsWith('/api/admin/');
  const isDownloadApi = isSameOrigin && url.pathname.startsWith('/api/download/');
  const isCatalogApi = isSameOrigin && url.pathname === '/api/catalog';

  // Never cache admin or download endpoints.
  if(isAdminApi || isDownloadApi) return;

  // Network-first for catalog with TTL fallback.
  if(isCatalogApi){
    event.respondWith(networkFirstCatalog(req));
    return;
  }

  // Navigation requests: shell fallback when offline.
  if(req.mode === 'navigate'){
    event.respondWith(navigationWithFallback(req));
    return;
  }

  // Everything else same-origin: cache-first for the shell.
  if(isSameOrigin){
    event.respondWith(cacheFirstShell(req));
    return;
  }

  // Cross-origin (fonts, Formspree): let the network handle it.
});

async function networkFirstCatalog(req){
  const cache = await caches.open(API_CACHE);
  try {
    const fresh = await fetch(req);
    if(fresh && fresh.ok){
      const copy = fresh.clone();
      // Store body + timestamp header.
      const headers = new Headers(copy.headers);
      headers.set('x-sw-cached-at', String(Date.now()));
      const body = await copy.blob();
      await cache.put(req, new Response(body, {status: 200, headers}));
    }
    return fresh;
  } catch(err){
    const cached = await cache.match(req);
    if(cached){
      const cachedAt = Number(cached.headers.get('x-sw-cached-at') || 0);
      if(Date.now() - cachedAt < CATALOG_TTL_MS){
        return cached;
      }
      // Stale but usable — return with a warning header.
      const headers = new Headers(cached.headers);
      headers.set('x-sw-stale', '1');
      const body = await cached.blob();
      return new Response(body, {status: 200, headers});
    }
    return new Response(JSON.stringify({error: 'Offline'}), {
      status: 503,
      headers: {'Content-Type': 'application/json'}
    });
  }
}

async function navigationWithFallback(req){
  try {
    return await fetch(req);
  } catch(err){
    const cache = await caches.open(SHELL_CACHE);
    const cached = await cache.match('/index.html') || await cache.match('/');
    if(cached) return cached;
    return new Response('Offline', {status: 503, headers: {'Content-Type': 'text/plain'}});
  }
}

async function cacheFirstShell(req){
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(req);
  if(cached) return cached;
  try {
    const fresh = await fetch(req);
    if(fresh && fresh.ok && new URL(req.url).origin === self.location.origin){
      cache.put(req, fresh.clone()).catch(() => {});
    }
    return fresh;
  } catch(err){
    return new Response('Offline', {status: 503});
  }
}