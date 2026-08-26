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

    if (message.direction === "system") {
      return <div class="system-message">{message.body}</div>;
    }

    return (
      <div
        id={`message-${message.id}`}
        class={{
          "message-line": true,
          outbound: message.direction === "outbound",
          "proof-highlight": highlighted,
        }}
      >
        <div class="message-bubble">
          {message.type === "image" || message.type === "document" ? (
            <div class="message-attachment-copy">
              <Icon name="file" size={18} />
              <span>
                <strong>
                  {message.filename ||
                    (message.type === "image"
                      ? "Imagen recibida"
                      : "Documento")}
                </strong>
                <small>{message.body}</small>
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
                    disabled={openingMedia.value}
                    onClick$={async () => {
                      if (openingMedia.value) return;
                      openingMedia.value = true;
                      mediaError.value = "";
                      const previewWindow = window.open(
                        "about:blank",
                        "_blank",
                      );
                      try {
                        if (!previewWindow) throw new Error("POPUP_BLOCKED");
                        previewWindow.opener = null;
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
                        if (!response.ok) throw new Error("MEDIA_UNAVAILABLE");
                        const blobUrl = URL.createObjectURL(
                          await response.blob(),
                        );
                        previewWindow.location.replace(blobUrl);
                        window.setTimeout(
                          () => URL.revokeObjectURL(blobUrl),
                          300_000,
                        );
                      } catch {
                        previewWindow?.close();
                        mediaError.value =
                          "No pudimos abrir el comprobante. Intentá nuevamente.";
                      } finally {
                        openingMedia.value = false;
                      }
                    }}
                  >
                    {openingMedia.value
                      ? "Abriendo…"
                      : message.type === "image"
                        ? "Ver imagen"
                        : "Abrir comprobante"}
                  </button>
                )}
                {mediaError.value && (
                  <small class="message-attachment-error" role="alert">
                    {mediaError.value}
                  </small>
                )}
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
