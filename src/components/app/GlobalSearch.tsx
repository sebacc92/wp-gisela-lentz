import {
  $,
  component$,
  useSignal,
  useStore,
  useVisibleTask$,
} from "@qwik.dev/core";
import { useNavigate } from "@qwik.dev/router";
import { Icon } from "~/components/ui/Icon";
import {
  GLOBAL_SEARCH_MIN_LENGTH,
  groupResults,
  KIND_LABELS,
  type GlobalSearchResult,
} from "~/lib/global-search";
import { getSupabaseClient } from "~/lib/supabase/client";
import { runGlobalSearch } from "~/lib/supabase/global-search";
import "./global-search.css";

/**
 * Búsqueda global con Ctrl/⌘ + K.
 *
 * Es un atajo para llegar a un paciente, un turno o una conversación sin pasar
 * por el menú. No cambia nada: sólo navega.
 *
 * El atajo se captura en toda la aplicación, también dentro de un campo de
 * texto: es lo que se espera de Ctrl/⌘ + K y no pisa ningún atajo de edición.
 * Escape cierra sin navegar.
 */
export const GlobalSearch = component$(() => {
  const navigate = useNavigate();
  const open = useSignal(false);
  const query = useSignal("");
  const activeIndex = useSignal(0);
  const inputRef = useSignal<HTMLInputElement>();
  const state = useStore<{ results: GlobalSearchResult[]; searching: boolean }>(
    { results: [], searching: false },
  );

  // eslint-disable-next-line qwik/no-use-visible-task
  useVisibleTask$(({ cleanup }) => {
    const onKeyDown = (event: KeyboardEvent) => {
      const isShortcut =
        (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k";
      if (!isShortcut) return;
      event.preventDefault();
      open.value = !open.value;
    };
    window.addEventListener("keydown", onKeyDown);
    cleanup(() => window.removeEventListener("keydown", onKeyDown));
  });

  // eslint-disable-next-line qwik/no-use-visible-task
  useVisibleTask$(({ track }) => {
    const isOpen = track(() => open.value);
    if (!isOpen) {
      query.value = "";
      state.results = [];
      activeIndex.value = 0;
      return;
    }
    window.requestAnimationFrame(() => inputRef.value?.focus());
  });

  // eslint-disable-next-line qwik/no-use-visible-task
  useVisibleTask$(({ track, cleanup }) => {
    const value = track(() => query.value).trim();
    if (value.length < GLOBAL_SEARCH_MIN_LENGTH) {
      state.results = [];
      state.searching = false;
      return;
    }

    let cancelled = false;
    state.searching = true;
    const timer = window.setTimeout(async () => {
      try {
        const results = await runGlobalSearch(getSupabaseClient(), value);
        if (!cancelled) {
          state.results = results;
          activeIndex.value = 0;
        }
      } catch {
        if (!cancelled) state.results = [];
      } finally {
        if (!cancelled) state.searching = false;
      }
    }, 220);

    cleanup(() => {
      cancelled = true;
      window.clearTimeout(timer);
    });
  });

  const go = $(async (result: GlobalSearchResult) => {
    open.value = false;
    await navigate(result.href);
  });

  if (!open.value) return null;

  const groups = groupResults(state.results);
  // Índice plano para que las flechas recorran todos los grupos seguidos.
  const flat = groups.flatMap((group) => group.items);

  return (
    <div
      class="global-search-layer"
      role="presentation"
      onClick$={() => (open.value = false)}
    >
      <div
        class="global-search"
        role="dialog"
        aria-modal="true"
        aria-label="Buscar en la aplicación"
        stoppropagation:click
      >
        <div class="global-search-field">
          <Icon name="search" size={18} />
          <input
            ref={inputRef}
            type="search"
            value={query.value}
            placeholder="Buscar un paciente, un turno o una conversación…"
            aria-label="Buscar"
            autoComplete="off"
            onInput$={(_, element) => (query.value = element.value)}
            onKeyDown$={async (event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                open.value = false;
                return;
              }
              if (event.key === "ArrowDown") {
                event.preventDefault();
                activeIndex.value = Math.min(
                  activeIndex.value + 1,
                  Math.max(0, flat.length - 1),
                );
                return;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                activeIndex.value = Math.max(activeIndex.value - 1, 0);
                return;
              }
              if (event.key === "Enter") {
                const target = flat[activeIndex.value];
                if (target) {
                  event.preventDefault();
                  await go(target);
                }
              }
            }}
          />
          <kbd>Esc</kbd>
        </div>

        <div class="global-search-results">
          {query.value.trim().length < GLOBAL_SEARCH_MIN_LENGTH ? (
            <p class="global-search-hint">
              Escribí al menos {GLOBAL_SEARCH_MIN_LENGTH} letras. Se busca por
              nombre y por teléfono.
            </p>
          ) : state.searching ? (
            <p class="global-search-hint" role="status">
              <span class="small-spinner" aria-hidden="true" /> Buscando…
            </p>
          ) : flat.length === 0 ? (
            <p class="global-search-hint">No encontramos nada con ese texto.</p>
          ) : (
            groups.map((group) => (
              <section key={group.kind}>
                <h2>{KIND_LABELS[group.kind]}</h2>
                <ul>
                  {group.items.map((result) => {
                    const index = flat.indexOf(result);
                    return (
                      <li key={`${result.kind}-${result.id}`}>
                        <button
                          type="button"
                          class={{ active: index === activeIndex.value }}
                          onMouseEnter$={() => (activeIndex.value = index)}
                          onClick$={() => go(result)}
                        >
                          <strong>{result.title}</strong>
                          <small>{result.subtitle}</small>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))
          )}
        </div>
      </div>
    </div>
  );
});
