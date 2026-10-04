// Service worker de Nutri AI.
// Estrategia: red primero con límite de espera. Si la red responde en menos de NET_TIMEOUT ms se usa
// la versión más nueva; si va lenta o no hay conexión, se sirve lo último guardado (y la caché se
// actualiza igualmente en segundo plano). Las llamadas a /api/ (la IA) NUNCA se guardan ni se interceptan.
const CACHE = "nutri-ai-v6";
const NET_TIMEOUT = 3000;
// Imprescindibles para abrir la app. Si falla alguno, no se instala.
const CORE = ["/", "/index.html"];
// Opcionales: si alguno da 404 o falla, no rompe la instalación.
const OPTIONAL = ["/manifest.json", "/icons/icon-192.png", "/icons/icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(CORE).then(() => Promise.allSettled(OPTIONAL.map((u) => c.add(u)))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  // Petición a la red; si responde bien, guarda una copia.
  const network = fetch(req).then((res) => {
    if (res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
    }
    return res;
  });
  // Mantiene vivo el service worker hasta terminar de refrescar la caché, aunque ya hayamos respondido.
  e.waitUntil(network.catch(() => {}));

  e.respondWith(
    caches.match(req).then((hit) => {
      // Sin copia guardada: toca esperar a la red (solo las páginas caen al index.html sin conexión).
      if (!hit) {
        return network.catch(() =>
          req.mode === "navigate" ? caches.match("/index.html") : Response.error()
        );
      }
      // Con copia: la red tiene NET_TIMEOUT ms para ganar; si no, se sirve la copia.
      const slow = new Promise((resolve) => setTimeout(() => resolve(hit), NET_TIMEOUT));
      return Promise.race([network, slow]).catch(() => hit);
    })
  );
});
