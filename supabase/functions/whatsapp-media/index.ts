import { corsHeaders, jsonResponse, optionsResponse } from "../_shared/http.ts";
import { authorizeUser, createServiceClient } from "../_shared/supabase.ts";
import {
  WhatsAppMediaValidationError,
  isValidMessageUuid,
  whatsappMediaMaxBytes,
} from "../_shared/whatsapp-media.ts";
import {
  WhatsAppMediaDownloadError,
  downloadInboundWhatsAppMedia,
} from "../_shared/whatsapp-media-download.ts";
import { isWhatsAppCredentialResolutionError } from "../_shared/whatsapp-account-credentials.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.112.2";

function mediaError(
  request: Request,
  status: number,
  error: string,
  message: string,
): Response {
  return jsonResponse(request, { error, message }, status);
}

export interface WhatsAppMediaHandlerDependencies {
  client?: SupabaseClient;
  authorize?: typeof authorizeUser;
  fetchImpl?: typeof fetch;
}

export async function handleWhatsAppMediaRequest(
  request: Request,
  dependencies: WhatsAppMediaHandlerDependencies = {},
): Promise<Response> {
  if (request.method === "OPTIONS") return optionsResponse(request);
  if (request.method !== "GET") {
    return mediaError(
      request,
      405,
      "METHOD_NOT_ALLOWED",
      "Método no permitido.",
    );
  }

  const client = dependencies.client ?? createServiceClient();
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  try {
    const { user } = await (dependencies.authorize ?? authorizeUser)(
      request,
      client,
    );
    const messageId =
      new URL(request.url).searchParams.get("messageId")?.trim() ?? "";
    if (!isValidMessageUuid(messageId)) {
      return mediaError(
        request,
        400,
        "INVALID_MESSAGE_ID",
        "El archivo solicitado no es válido.",
      );
    }

    const { data: message, error: messageError } = await client
      .from("messages")
      .select(
        "id,conversation_id,direction,type,metadata,coexistence_account_id",
      )
      .eq("id", messageId)
      .maybeSingle();
    if (
      messageError ||
      !message ||
      message.direction !== "inbound" ||
      (message.type !== "image" &&
        message.type !== "document" &&
        message.type !== "audio")
    ) {
      return mediaError(
        request,
        404,
        "MEDIA_NOT_FOUND",
        "El archivo no está disponible.",
      );
    }

    const { bytes, descriptor } = await downloadInboundWhatsAppMedia({
      client,
      message,
      fetchImpl,
      maxBytes: whatsappMediaMaxBytes(Deno.env.get("WHATSAPP_MEDIA_MAX_BYTES")),
    });

    const { error: auditError } = await client.from("audit_logs").insert({
      actor_user_id: user.id,
      action: "whatsapp.media_viewed",
      entity_type: "message",
      entity_id: messageId,
      metadata: { message_type: descriptor.type, byte_size: bytes.byteLength },
    });
    if (auditError) console.warn("whatsapp-media", "MEDIA_AUDIT_FAILED");

    return new Response(bytes, {
      status: 200,
      headers: {
        ...corsHeaders(request),
        "Content-Type": descriptor.mimeType,
        "Content-Length": String(bytes.byteLength),
        "Content-Disposition": `${descriptor.disposition}; filename*=UTF-8''${encodeURIComponent(descriptor.filename)}`,
        "Cache-Control": "private, no-store, max-age=0",
        Pragma: "no-cache",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox; default-src 'none'",
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return mediaError(
        request,
        401,
        "UNAUTHORIZED",
        "Iniciá sesión nuevamente.",
      );
    }
    if (error instanceof WhatsAppMediaValidationError) {
      return mediaError(
        request,
        415,
        "MEDIA_NOT_ALLOWED",
        "Este archivo no puede abrirse de forma segura.",
      );
    }
    if (error instanceof WhatsAppMediaDownloadError) {
      const notFound = error.code === "MEDIA_NOT_FOUND";
      if (!notFound) console.error("whatsapp-media", "MEDIA_PROXY_FAILED");
      return mediaError(
        request,
        notFound ? 404 : 502,
        notFound ? "MEDIA_NOT_FOUND" : "MEDIA_UNAVAILABLE",
        notFound
          ? "El archivo no está disponible."
          : "No pudimos abrir el archivo en este momento.",
      );
    }
    const configurationError =
      (error instanceof Error &&
        error.message.startsWith("CONFIGURATION_INCOMPLETE")) ||
      isWhatsAppCredentialResolutionError(error);
    console.error(
      "whatsapp-media",
      configurationError ? "CONFIGURATION_INCOMPLETE" : "MEDIA_PROXY_FAILED",
    );
    return mediaError(
      request,
      configurationError ? 503 : 502,
      configurationError ? "CONFIGURATION_INCOMPLETE" : "MEDIA_UNAVAILABLE",
      "No pudimos abrir el archivo en este momento.",
    );
  }
}

if (import.meta.main) {
  Deno.serve((request) => handleWhatsAppMediaRequest(request));
}
