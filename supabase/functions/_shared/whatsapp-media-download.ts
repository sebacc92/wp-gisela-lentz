import type { SupabaseClient } from "npm:@supabase/supabase-js@2.112.2";

import { resolveWhatsAppAccountCredentials } from "./whatsapp-account-credentials.ts";
import { observeMetaGraphAuthenticationFailure } from "./whatsapp.ts";
import {
  WhatsAppMediaValidationError,
  assertWhatsAppMediaResponseType,
  isAllowedWhatsAppMediaDownloadUrl,
  isValidWhatsAppMediaId,
  readBodyWithLimit,
  resolveWhatsAppMediaDescriptor,
  type WhatsAppMediaDescriptor,
} from "./whatsapp-media.ts";

export const WHATSAPP_MEDIA_FETCH_TIMEOUT_MS = 10_000;

interface MetaMediaInformation {
  id?: unknown;
  messaging_product?: unknown;
  url?: unknown;
  mime_type?: unknown;
  file_size?: unknown;
}

/** Meta distingue un adjunto que ya no existe de una falla del proveedor. La
 * diferencia importa: lo primero es definitivo y lo segundo se reintenta. */
export type WhatsAppMediaDownloadCode = "MEDIA_NOT_FOUND" | "MEDIA_UNAVAILABLE";

export class WhatsAppMediaDownloadError extends Error {
  readonly code: WhatsAppMediaDownloadCode;

  constructor(code: WhatsAppMediaDownloadCode) {
    super(code);
    this.name = "WhatsAppMediaDownloadError";
    this.code = code;
  }
}

export interface InboundWhatsAppMediaMessage {
  direction?: unknown;
  type?: unknown;
  metadata?: unknown;
  conversation_id?: unknown;
  coexistence_account_id?: unknown;
}

export interface DownloadedWhatsAppMedia {
  bytes: Uint8Array<ArrayBuffer>;
  descriptor: WhatsAppMediaDescriptor;
}

async function timedFetch(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
): Promise<{ response: Response; finish: () => void }> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    WHATSAPP_MEDIA_FETCH_TIMEOUT_MS,
  );
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

function failureFor(response: Response): WhatsAppMediaDownloadError {
  return new WhatsAppMediaDownloadError(
    response.status === 404 ? "MEDIA_NOT_FOUND" : "MEDIA_UNAVAILABLE",
  );
}

/**
 * Descarga un adjunto entrante de WhatsApp con la credencial de la cuenta que
 * lo recibió. Es el único camino de descarga: la bandeja lo usa para que una
 * persona abra el archivo y la automatización para poder leerlo, así que las
 * validaciones de identidad, MIME y tamaño viven en un solo lugar.
 *
 * Nunca devuelve la URL de Meta ni el token: sólo los bytes ya validados.
 */
export async function downloadInboundWhatsAppMedia(args: {
  client: SupabaseClient;
  message: InboundWhatsAppMediaMessage;
  fetchImpl: typeof fetch;
  maxBytes: number;
}): Promise<DownloadedWhatsAppMedia> {
  const metadata =
    args.message.metadata &&
    typeof args.message.metadata === "object" &&
    !Array.isArray(args.message.metadata)
      ? (args.message.metadata as Record<string, unknown>)
      : {};
  const storedMediaId = metadata.media_id;
  if (!isValidWhatsAppMediaId(storedMediaId)) {
    throw new WhatsAppMediaDownloadError("MEDIA_NOT_FOUND");
  }

  const credentials = await resolveWhatsAppAccountCredentials({
    client: args.client,
    purpose: "media",
    coexistenceAccountId:
      typeof args.message.coexistence_account_id === "string"
        ? args.message.coexistence_account_id
        : null,
    conversationId:
      typeof args.message.conversation_id === "string"
        ? args.message.conversation_id
        : null,
  });

  const informationUrl = new URL(
    `${credentials.apiVersion}/${encodeURIComponent(storedMediaId)}`,
    "https://graph.facebook.com/",
  );
  informationUrl.searchParams.set("phone_number_id", credentials.phoneNumberId);
  const informationRequest = await timedFetch(
    informationUrl.toString(),
    {
      method: "GET",
      redirect: "error",
      headers: { Authorization: `Bearer ${credentials.businessAccessToken}` },
    },
    args.fetchImpl,
  );
  let information: MetaMediaInformation;
  try {
    const credentialInvalid = await observeMetaGraphAuthenticationFailure({
      client: args.client,
      credentials,
      response: informationRequest.response,
    });
    if (credentialInvalid) {
      throw new WhatsAppMediaDownloadError("MEDIA_UNAVAILABLE");
    }
    if (!informationRequest.response.ok) {
      throw failureFor(informationRequest.response);
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

  const descriptor = resolveWhatsAppMediaDescriptor({
    messageDirection: args.message.direction,
    messageType: args.message.type,
    metadata,
    graphMediaId: information.id,
    graphMimeType: information.mime_type,
    graphFileSize: information.file_size,
    maxBytes: args.maxBytes,
  });

  const mediaRequest = await timedFetch(
    information.url as string,
    {
      method: "GET",
      redirect: "error",
      headers: { Authorization: `Bearer ${credentials.businessAccessToken}` },
    },
    args.fetchImpl,
  );
  try {
    const credentialInvalid = await observeMetaGraphAuthenticationFailure({
      client: args.client,
      credentials,
      response: mediaRequest.response,
    });
    if (credentialInvalid) {
      throw new WhatsAppMediaDownloadError("MEDIA_UNAVAILABLE");
    }
    if (!mediaRequest.response.ok) {
      throw failureFor(mediaRequest.response);
    }
    assertWhatsAppMediaResponseType(
      mediaRequest.response.headers.get("content-type"),
      descriptor.mimeType,
    );
    return {
      bytes: await readBodyWithLimit(mediaRequest.response, args.maxBytes),
      descriptor,
    };
  } finally {
    mediaRequest.finish();
  }
}
