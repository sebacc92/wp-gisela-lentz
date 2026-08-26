import { corsHeaders, jsonResponse, optionsResponse } from "../_shared/http.ts";
import { authorizeUser, createServiceClient } from "../_shared/supabase.ts";
import {
  WhatsAppMediaValidationError,
  assertWhatsAppMediaResponseType,
  isAllowedWhatsAppMediaDownloadUrl,
  isValidMessageUuid,
  isValidWhatsAppMediaId,
  readBodyWithLimit,
  resolveWhatsAppMediaDescriptor,
  whatsappMediaMaxBytes,
} from "../_shared/whatsapp-media.ts";
import {
  isWhatsAppCredentialResolutionError,
  resolveWhatsAppAccountCredentials,
} from "../_shared/whatsapp-account-credentials.ts";
import { observeMetaGraphAuthenticationFailure } from "../_shared/whatsapp.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.112.2";

interface MetaMediaInformation {
  id?: unknown;
  messaging_product?: unknown;
  url?: unknown;
  mime_type?: unknown;
  file_size?: unknown;
}

const FETCH_TIMEOUT_MS = 10_000;

async function timedFetch(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
): Promise<{ response: Response; finish: () => void }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      ...init,
      signal: controller.signal,
    });
    return {
      response,
      finish: () => {
        clearTimeout(timeout);
        controller.abort();
      },
    };
  } catch (error) {
    clearTimeout(timeout);
    throw error;
  }
}

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
        "El comprobante solicitado no es válido.",
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
      (message.type !== "image" && message.type !== "document")
    ) {
      return mediaError(
        request,
        404,
        "MEDIA_NOT_FOUND",
        "El comprobante no está disponible.",
      );
    }

    const metadata =
      message.metadata && typeof message.metadata === "object"
        ? (message.metadata as Record<string, unknown>)
        : {};
    const storedMediaId = metadata.media_id;
    if (!isValidWhatsAppMediaId(storedMediaId)) {
      return mediaError(
        request,
        404,
        "MEDIA_NOT_FOUND",
        "El comprobante no está disponible.",
      );
    }

    const credentials = await resolveWhatsAppAccountCredentials({
      client,
      purpose: "media",
      coexistenceAccountId:
        typeof message.coexistence_account_id === "string"
          ? message.coexistence_account_id
          : null,
      conversationId: message.conversation_id,
    });
    const informationUrl = new URL(
      `${credentials.apiVersion}/${encodeURIComponent(storedMediaId)}`,
      "https://graph.facebook.com/",
    );
    informationUrl.searchParams.set(
      "phone_number_id",
      credentials.phoneNumberId,
    );
    const informationRequest = await timedFetch(
      informationUrl.toString(),
      {
        method: "GET",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${credentials.businessAccessToken}`,
        },
      },
      fetchImpl,
    );
    let information: MetaMediaInformation;
    try {
      const credentialInvalid = await observeMetaGraphAuthenticationFailure({
        client,
        credentials,
        response: informationRequest.response,
      });
      if (credentialInvalid) {
        return mediaError(
          request,
          502,
          "MEDIA_UNAVAILABLE",
          "No pudimos obtener el comprobante desde WhatsApp.",
        );
      }
      if (!informationRequest.response.ok) {
        return mediaError(
          request,
          informationRequest.response.status === 404 ? 404 : 502,
          "MEDIA_UNAVAILABLE",
          "No pudimos obtener el comprobante desde WhatsApp.",
        );
      }
      information =
        (await informationRequest.response.json()) as MetaMediaInformation;
    } finally {
      informationRequest.finish();
    }
    if (
      information.messaging_product !== "whatsapp" ||
      !isAllowedWhatsAppMediaDownloadUrl(information.url)
    ) {
      throw new WhatsAppMediaValidationError("MEDIA_INFORMATION_INVALID");
    }

    const maxBytes = whatsappMediaMaxBytes(
      Deno.env.get("WHATSAPP_MEDIA_MAX_BYTES"),
    );
    const descriptor = resolveWhatsAppMediaDescriptor({
      messageDirection: message.direction,
      messageType: message.type,
      metadata,
      graphMediaId: information.id,
      graphMimeType: information.mime_type,
      graphFileSize: information.file_size,
      maxBytes,
    });
    const mediaRequest = await timedFetch(
      information.url as string,
      {
        method: "GET",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${credentials.businessAccessToken}`,
        },
      },
      fetchImpl,
    );
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      const credentialInvalid = await observeMetaGraphAuthenticationFailure({
        client,
        credentials,
        response: mediaRequest.response,
      });
      if (credentialInvalid) {
        return mediaError(
          request,
          502,
          "MEDIA_UNAVAILABLE",
          "No pudimos descargar el comprobante desde WhatsApp.",
        );
      }
      if (!mediaRequest.response.ok) {
        return mediaError(
          request,
          mediaRequest.response.status === 404 ? 404 : 502,
          "MEDIA_UNAVAILABLE",
          "No pudimos descargar el comprobante desde WhatsApp.",
        );
      }
      assertWhatsAppMediaResponseType(
        mediaRequest.response.headers.get("content-type"),
        descriptor.mimeType,
      );
      bytes = await readBodyWithLimit(mediaRequest.response, maxBytes);
    } finally {
      mediaRequest.finish();
    }

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
      "No pudimos abrir el comprobante en este momento.",
    );
  }
}

if (import.meta.main) {
  Deno.serve((request) => handleWhatsAppMediaRequest(request));
}
