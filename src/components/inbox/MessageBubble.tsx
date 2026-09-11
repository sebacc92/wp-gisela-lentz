import { component$, useSignal } from "@qwik.dev/core";
import type { Message } from "~/lib/inbox-types";
import { Icon } from "../ui/Icon";
import { MediaViewer } from "./MediaViewer";

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
    const viewerOpen = useSignal(false);
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
                {message.direction === "inbound" && message.hasMedia && (
                  <button
                    class="message-attachment-open"
                    type="button"
                    onClick$={() => (viewerOpen.value = true)}
                  >
                    <Icon name={isAudio ? "message" : "file"} size={15} />
                    <span>
                      {message.type === "image"
                        ? "Ver imagen"
                        : isAudio
                          ? "Escuchar audio"
                          : "Abrir comprobante"}
                    </span>
                  </button>
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

        {viewerOpen.value && (
          <MediaViewer
            messageId={message.id}
            messageType={message.type}
            filename={message.filename}
            onClose$={() => (viewerOpen.value = false)}
          />
        )}
      </div>
    );
  },
);
