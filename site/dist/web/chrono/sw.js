// packs/web/host/sw.ts
var CACHE = `puck-web-${"7e3e3bc987"}`;
var PRECACHE = ["./", "index.html", "emu.0972e58d85.wasm", "host.a43b8d2f96.js", "manifest.webmanifest", "icon.svg", "icon-192.png", "icon-512.png"];
var sw = self;
sw.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(PRECACHE);
    await sw.skipWaiting();
  })());
});
sw.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith("puck-web-") && name !== CACHE)
        await caches.delete(name);
    }
    await sw.clients.claim();
  })());
});
sw.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET")
    return;
  if (url.origin !== sw.location.origin)
    return;
  e.respondWith((async () => {
    const hit = await caches.match(e.request);
    if (hit)
      return hit;
    const res = await fetch(e.request);
    if (res.ok && res.type === "basic") {
      const cache = await caches.open(CACHE);
      cache.put(e.request, res.clone());
    }
    return res;
  })());
});
