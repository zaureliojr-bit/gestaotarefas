const CACHE_PREFIX = "drogalink-tarefas-offline-";
const CACHE_NAME = CACHE_PREFIX + "v1";
const OFFLINE_PAGE = "/offline.html";

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.add(new Request(OFFLINE_PAGE, { cache: "reload", redirect: "error" }));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET" || request.mode !== "navigate") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || (url.pathname !== "/" && url.pathname !== "/index.html")) return;

  // API, login, logout e páginas autenticadas nunca são gravados no Cache Storage.
  event.respondWith(fetch(request, { cache: "no-store" }).catch(async () => {
    const page = await (await caches.open(CACHE_NAME)).match(OFFLINE_PAGE);
    return page ?? new Response("Sem conexão. Tente novamente quando estiver online.", {
      status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" }
    });
  }));
});
