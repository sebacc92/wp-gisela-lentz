import { component$, useSignal } from "@qwik.dev/core";
import type { Message } from "~/lib/inbox-types";
import { getSupabaseClient } from "~/lib/supabase/client";
import { Icon } from "../ui/Icon";

interface MessageBubbleProps {
  message: Message;
  highlighted?: boolean;
}

const statusLabel = {
  pending: "Enviando",
  sent: "Enviado",
  delivered: "Entregado",
  read: "Leído",
  failed: "No enviado",
};

export const MessageBubble = component$<MessageBubbleProps>(
  ({ message, highlighted }) => {
    const openingMedia = useSignal(false);
    const mediaError = useSignal("");
    const audioUrl = useSignal("");
    const isAudio = message.type === "audio";

    if (message.direction === "system") {
      return (
        <div class="system-message" role="note">
          {message.body}
        </div>
      );
    }

    return (
      <div
        id={`message-${message.id}`}
        class={{
          "message-line": true,
          outbound: message.direction === "outbound",
          "proof-highlight": highlighted,
        }}
        role="article"
      >
        <span class="sr-only">
          {message.direction === "outbound"
            ? "Mensaje enviado"
            : "Mensaje recibido"}{" "}
          a las {message.time}:
        </span>
        <div class="message-bubble">
          {message.type === "image" ||
          message.type === "document" ||
          isAudio ? (
            <div class="message-attachment-copy">
              <Icon name="file" size={18} />
              <span>
                <strong>
                  {message.filename ||
                    (message.type === "image"
                      ? "Imagen recibida"
                      : isAudio
                        ? message.body
                        : "Documento")}
                </strong>
                {!isAudio && <small>{message.body}</small>}
                {message.depositProofLate && (
                  <small class="message-attachment-late" role="alert">
                    Llegó después de vencer la reserva. Revisar sin confirmar
                    automáticamente.
                  </small>
                )}
                {message.direction === "inbound" &&
                  message.hasMedia &&
                  !audioUrl.value && (
                    <button
                      class="message-attachment-open"
                      type="button"
                      disabled={openingMedia.value}
                      aria-busy={openingMedia.value}
                      onClick$={async () => {
                        if (openingMedia.value) return;
                        openingMedia.value = true;
                        mediaError.value = "";
                        // Una nota de voz se escucha en contexto: abrir una
                        // pestaña por cada audio haría inusable la bandeja.
                        const previewWindow = isAudio
                          ? null
                          : window.open("about:blank", "_blank");
                        try {
                          if (!isAudio && !previewWindow) {
                            throw new Error("POPUP_BLOCKED");
                          }
                          if (previewWindow) previewWindow.opener = null;
                          const client = getSupabaseClient();
                          const { data: sessionData } =
                            await client.auth.getSession();
                          const token = sessionData.session?.access_token;
                          if (!token) throw new Error("UNAUTHORIZED");
                          const baseUrl = String(
                            import.meta.env.PUBLIC_SUPABASE_URL ?? "",
                          ).replace(/\/$/, "");
                          const response = await fetch(
                            `${baseUrl}/functions/v1/whatsapp-media?messageId=${encodeURIComponent(message.id)}`,
                            { headers: { Authorization: `Bearer ${token}` } },
                          );
                          if (!response.ok)
                            throw new Error("MEDIA_UNAVAILABLE");
                          const blobUrl = URL.createObjectURL(
                            await response.blob(),
                          );
                          if (previewWindow) {
                            previewWindow.location.replace(blobUrl);
                            window.setTimeout(
                              () => URL.revokeObjectURL(blobUrl),
                              300_000,
                            );
                          } else {
                            audioUrl.value = blobUrl;
                          }
                        } catch {
                          previewWindow?.close();
                          mediaError.value = isAudio
                            ? "No pudimos abrir el audio. Intentá nuevamente."
                            : "No pudimos abrir el comprobante. Intentá nuevamente.";
                        } finally {
                          openingMedia.value = false;
                        }
                      }}
                    >
                      {openingMedia.value ? (
                        <>
                          <span class="small-spinner" aria-hidden="true" />
                          <span>Abriendo…</span>
                        </>
                      ) : (
                        <>
                          <Icon name={isAudio ? "message" : "file"} size={15} />
                          <span>
                            {message.type === "image"
                              ? "Ver imagen"
                              : isAudio
                                ? "Escuchar audio"
                                : "Abrir comprobante"}
                          </span>
                        </>
                      )}
                    </button>
                  )}
                {audioUrl.value && (
                  <audio
                    class="message-attachment-audio"
                    controls
                    preload="metadata"
                    src={audioUrl.value}
                    aria-label={message.filename || "Nota de voz recibida"}
                  />
                )}
                {mediaError.value && (
                  <small class="message-attachment-error" role="alert">
                    {mediaError.value}
                  </small>
                )}
              </span>
            </div>
          ) : message.type === "location" && message.location ? (
            <div class="message-location-card">
              <Icon name="map-pin" size={22} />
              <span class="message-location-copy">
                <strong>{message.location.name}</strong>
                <small>{message.location.address}</small>
                <a
                  href={message.location.mapUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Abrir en Google Maps
                </a>
              </span>
            </div>
          ) : (
            <p>{message.body}</p>
          )}
          <span class="message-meta">
            <time>{message.time}</time>
            {message.direction === "outbound" && message.status && (
              <span
                class={{
                  "message-status": true,
                  read: message.status === "read",
                  failed: message.status === "failed",
                }}
                title={statusLabel[message.status]}
                role="status"
                aria-live="polite"
              >
                {message.status === "pending" ? (
                  <Icon name="clock" size={13} />
                ) : message.status === "failed" ? (
                  <Icon name="alert" size={13} />
                ) : (
                  <>
                    <Icon name="check" size={13} />
                    {(message.status === "delivered" ||
                      message.status === "read") && (
                      <Icon name="check" size={13} />
                    )}
                  </>
                )}
                <span class="sr-only">{statusLabel[message.status]}</span>
              </span>
            )}
          </span>
        </div>
      </div>
    );
  },
);
