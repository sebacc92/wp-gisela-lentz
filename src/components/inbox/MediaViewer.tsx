import {
  $,
  component$,
  useSignal,
  useStore,
  useVisibleTask$,
  type QRL,
} from "@qwik.dev/core";
import { mediaKind, mediaKindLabel, type MediaKind } from "~/lib/media-kind";
import { fetchWhatsAppMediaUrl } from "~/lib/supabase/whatsapp-media";
import { Icon } from "../ui/Icon";
import "./media-viewer.css";

interface MediaViewerProps {
  messageId: string;
  messageType?: string | null;
  filename?: string | null;
  onClose$: QRL<() => void>;
}

const SPEEDS = [1, 1.5, 2] as const;

/**
 * Visor de adjuntos dentro de la bandeja.
 *
 * Antes cada adjunto abría una pestaña nueva, que en un día de trabajo deja la
 * bandeja sepultada. Acá se mira en contexto y se cierra con Escape.
 *
 * El archivo se descarga con la sesión de quien mira y vive como `blob:`
 * mientras el visor está abierto; al cerrarse se revoca. La aplicación no
 * guarda los bytes en ningún momento.
 */
export const MediaViewer = component$<MediaViewerProps>((props) => {
  const dialogRef = useSignal<HTMLElement>();
  const audioRef = useSignal<HTMLAudioElement>();
  const speed = useSignal<number>(1);
  const state = useStore<{
    url: string;
    kind: MediaKind;
    loading: boolean;
    error: string;
  }>({ url: "", kind: "other", loading: true, error: "" });

  // eslint-disable-next-line qwik/no-use-visible-task
  useVisibleTask$(({ cleanup }) => {
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : undefined;
    let objectUrl = "";
    let cancelled = false;

    void (async () => {
      try {
        const media = await fetchWhatsAppMediaUrl(props.messageId);
        if (cancelled) {
          URL.revokeObjectURL(media.url);
          return;
        }
        objectUrl = media.url;
        state.url = media.url;
        state.kind = mediaKind({
          messageType: props.messageType,
          mimeType: media.mimeType,
        });
      } catch {
        if (!cancelled) {
          state.error =
            "No pudimos abrir el adjunto. Revisá la conexión e intentá de nuevo.";
        }
      } finally {
        if (!cancelled) state.loading = false;
      }
    })();

    dialogRef.value?.focus();
    cleanup(() => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      if (previous && document.contains(previous)) previous.focus();
    });
  });

  const cycleSpeed = $(() => {
    const next = SPEEDS[(SPEEDS.indexOf(speed.value as 1) + 1) % SPEEDS.length];
    speed.value = next;
    if (audioRef.value) audioRef.value.playbackRate = next;
  });

  const title = props.filename?.trim() || mediaKindLabel(state.kind);

  return (
    <div
      class="media-viewer-layer"
      role="presentation"
      onClick$={() => props.onClose$()}
    >
      <aside
        ref={dialogRef}
        class="media-viewer"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        aria-busy={state.loading}
        tabIndex={-1}
        stoppropagation:click
        onKeyDown$={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            props.onClose$();
          }
        }}
      >
        <header class="media-viewer-header">
          <strong>{title}</strong>
          <div class="media-viewer-header-actions">
            {state.url && (
              <a
                class="secondary-button small"
                href={state.url}
                download={props.filename || undefined}
              >
                Descargar
              </a>
            )}
            <button
              class="media-viewer-close"
              type="button"
              aria-label="Cerrar el adjunto"
              onClick$={() => props.onClose$()}
            >
              <Icon name="x" size={19} />
            </button>
          </div>
        </header>

        <div class="media-viewer-body">
          {state.loading ? (
            <p class="media-viewer-state" role="status">
              <span class="small-spinner" aria-hidden="true" /> Abriendo el
              adjunto…
            </p>
          ) : state.error ? (
            <p class="media-viewer-state" role="alert">
              <Icon name="alert" size={20} /> {state.error}
            </p>
          ) : state.kind === "image" ? (
            <img class="media-viewer-image" src={state.url} alt={title} />
          ) : state.kind === "pdf" ? (
            <iframe class="media-viewer-pdf" src={state.url} title={title} />
          ) : state.kind === "audio" ? (
            <div class="media-viewer-audio">
              <audio
                ref={audioRef}
                controls
                preload="metadata"
                src={state.url}
                aria-label={title}
              />
              <button
                class="secondary-button small"
                type="button"
                aria-label={`Velocidad de reproducción: ${speed.value}x. Tocar para cambiar.`}
                onClick$={cycleSpeed}
              >
                {speed.value}x
              </button>
            </div>
          ) : (
            <p class="media-viewer-state">
              <Icon name="file" size={20} /> Este archivo no se puede mostrar
              acá. Descargalo para abrirlo.
            </p>
          )}
        </div>
      </aside>
    </div>
  );
});
