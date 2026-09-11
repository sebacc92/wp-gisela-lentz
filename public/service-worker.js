/*
 * Service worker de Gisela Lentz.
 *
 * Es deliberadamente conservador. Esta aplicación maneja la agenda y los datos
 * de pacientes de un consultorio real, así que el service worker existe para
 * dos cosas y nada más: que la aplicación se pueda instalar y que los archivos
 * de build —que llevan hash en el nombre y no cambian nunca— no se vuelvan a
 * descargar.
 *
 * Lo que NO hace, a propósito:
 *
 * - No cachea documentos HTML. Si lo hiciera, un deploy podría quedar servido
 *   con la versión vieja y alguien vería una agenda desactualizada sin saberlo.
 * - No cachea nada de Supabase ni ninguna respuesta autenticada. Datos de
 *   pacientes en el cache del navegador serían un problema de privacidad, no
 *   una optimización.
 * - No responde nada offline. Sin red no hay agenda confiable, y mostrar datos
 *   viejos como si fueran actuales es peor que mostrar un error.
 */

const CACHE = "gl-static-v1";

// Sólo rutas con contenido inmutable (hash en el nombre del archivo).
const IMMUTABLE_PREFIXES = ["/build/", "/assets/"];
// Marca e íconos: cambian rara vez y se revalidan en segundo plano.
const REVALIDATE_PREFIXES = ["/brand/", "/images/"];

self.addEventListener("install", (event) => {
  // Sin precarga: una lista de precache se desactualiza con cada deploy.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((name) => name !== CACHE).map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

function matchesPrefix(pathname, prefixes) {
  return prefixes.some((prefix) => pathname.startsWith(prefix));
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Una navegación siempre va a la red: así un deploy se ve enseguida.
  if (request.mode === "navigate") return;

  const immutable = matchesPrefix(url.pathname, IMMUTABLE_PREFIXES);
  const revalidate = matchesPrefix(url.pathname, REVALIDATE_PREFIXES);
  if (!immutable && !revalidate) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(request);

      if (cached && immutable) return cached;

      const network = fetch(request)
        .then((response) => {
          // Sólo se guarda una respuesta completa y propia.
          if (response.ok && response.type === "basic") {
            cache.put(request, response.clone()).catch(() => {
              // Un cache lleno no puede romper la navegación.
            });
          }
          return response;
        })
        .catch(() => cached);

      return cached ?? network;
    })(),
  );
});
