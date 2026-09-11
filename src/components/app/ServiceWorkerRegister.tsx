import { component$, useVisibleTask$ } from "@qwik.dev/core";

/**
 * Registro del service worker.
 *
 * Qwik Router 2 ya no trae uno propio, así que el registro es explícito. El
 * worker sólo cachea archivos de build; el detalle y el porqué están en
 * `public/service-worker.js`.
 *
 * Si el registro falla, la aplicación funciona igual: es una mejora de carga y
 * de instalación, nunca un requisito.
 */
export const ServiceWorkerRegister = component$(() => {
  // eslint-disable-next-line qwik/no-use-visible-task
  useVisibleTask$(() => {
    if (!("serviceWorker" in navigator)) return;
    // En desarrollo un worker activo confunde más de lo que ayuda: deja
    // servido un bundle viejo mientras se está editando.
    if (import.meta.env.DEV) return;

    void navigator.serviceWorker.register("/service-worker.js").catch(() => {
      // Sin service worker la aplicación sigue andando igual.
    });
  });

  return null;
});
