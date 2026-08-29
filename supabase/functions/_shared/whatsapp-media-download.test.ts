import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.112.2";

import {
  WhatsAppMediaDownloadError,
  downloadInboundWhatsAppMedia,
} from "./whatsapp-media-download.ts";
import { WhatsAppMediaValidationError } from "./whatsapp-media.ts";

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";
const MEDIA_ID = "1234567890";
const DOWNLOAD_URL = "https://lookaside.fbsbx.com/whatsapp/media-one";

const originalApiVersion = process.env.WHATSAPP_GRAPH_API_VERSION;
process.env.WHATSAPP_GRAPH_API_VERSION = "v26.0";

after(() => {
  if (originalApiVersion === undefined) {
    delete process.env.WHATSAPP_GRAPH_API_VERSION;
  } else {
    process.env.WHATSAPP_GRAPH_API_VERSION = originalApiVersion;
  }
});

function credentialClient(): SupabaseClient {
  return {
    async rpc(name: string) {
      assert.equal(name, "resolve_whatsapp_account_credentials");
      return {
        data: [
          {
            credential_mode: "coexistence",
            account_id: ACCOUNT_ID,
            waba_id: "3333333333",
            phone_number_id: "4444444444",
            business_access_token: "business-token",
            token_generation: 3,
            coexistence_status: "active",
            onboarding_status: "completed",
            app_subscription_status: "subscribed",
            business_token_status: "active",
            business_token_validation_status: "valid",
            sending_paused: false,
          },
        ],
        error: null,
      };
    },
  } as unknown as SupabaseClient;
}

function audioMessage(overrides: Record<string, unknown> = {}) {
  return {
    direction: "inbound",
    type: "audio",
    metadata: { media_id: MEDIA_ID, mime_type: "audio/ogg" },
    conversation_id: CONVERSATION_ID,
    coexistence_account_id: ACCOUNT_ID,
    ...overrides,
  };
}

function graphFetch(options: {
  informationStatus?: number;
  information?: Record<string, unknown>;
  mediaStatus?: number;
  mediaContentType?: string;
  body?: Uint8Array;
  onUrl?: (url: string, init: RequestInit) => void;
}): typeof fetch {
  return (async (url: string | URL, init: RequestInit = {}) => {
    const target = String(url);
    options.onUrl?.(target, init);
    if (target.startsWith("https://graph.facebook.com/")) {
      return new Response(
        JSON.stringify(
          options.information ?? {
            id: MEDIA_ID,
            messaging_product: "whatsapp",
            url: DOWNLOAD_URL,
            mime_type: "audio/ogg",
            file_size: 2048,
          },
        ),
        {
          status: options.informationStatus ?? 200,
          headers: { "content-type": "application/json" },
        },
      );
    }
    const body = options.body ?? new Uint8Array([1, 2, 3, 4]);
    return new Response(body, {
      status: options.mediaStatus ?? 200,
      headers: {
        "content-type": options.mediaContentType ?? "audio/ogg",
        // Meta siempre declara el tamaño y la descarga falla cerrado si falta.
        "content-length": String(body.byteLength),
      },
    });
  }) as unknown as typeof fetch;
}

test("descarga una nota de voz y nunca expone la URL ni el token de Meta", async () => {
  const seenAuthorization: string[] = [];
  const result = await downloadInboundWhatsAppMedia({
    client: credentialClient(),
    message: audioMessage(),
    fetchImpl: graphFetch({
      onUrl: (_url, init) => {
        const headers = (init.headers ?? {}) as Record<string, string>;
        seenAuthorization.push(headers.Authorization ?? "");
      },
    }),
    maxBytes: 10_000,
  });

  assert.deepEqual(Array.from(result.bytes), [1, 2, 3, 4]);
  assert.equal(result.descriptor.type, "audio");
  assert.equal(result.descriptor.mimeType, "audio/ogg");
  assert.equal(result.descriptor.filename, "audio.ogg");
  // El llamado sale autenticado, pero lo devuelto son sólo bytes validados.
  assert.deepEqual(seenAuthorization, [
    "Bearer business-token",
    "Bearer business-token",
  ]);
  assert.equal(
    Object.prototype.hasOwnProperty.call(result, "url"),
    false,
    "la descarga no debe devolver la URL de Meta",
  );
});

test("distingue un adjunto inexistente de una caída del proveedor", async () => {
  for (const [status, expected] of [
    [404, "MEDIA_NOT_FOUND"],
    [500, "MEDIA_UNAVAILABLE"],
  ] as const) {
    await assert.rejects(
      downloadInboundWhatsAppMedia({
        client: credentialClient(),
        message: audioMessage(),
        fetchImpl: graphFetch({ informationStatus: status }),
        maxBytes: 10_000,
      }),
      (error: unknown) =>
        error instanceof WhatsAppMediaDownloadError && error.code === expected,
    );
  }

  await assert.rejects(
    downloadInboundWhatsAppMedia({
      client: credentialClient(),
      message: audioMessage(),
      fetchImpl: graphFetch({ mediaStatus: 502 }),
      maxBytes: 10_000,
    }),
    (error: unknown) =>
      error instanceof WhatsAppMediaDownloadError &&
      error.code === "MEDIA_UNAVAILABLE",
  );
});

test("un mensaje sin media_id válido no llega a pedirle nada a Meta", async () => {
  let called = false;
  await assert.rejects(
    downloadInboundWhatsAppMedia({
      client: credentialClient(),
      message: audioMessage({ metadata: { media_id: "no-es-un-id" } }),
      fetchImpl: (() => {
        called = true;
        throw new Error("NO_DEBERIA_LLAMARSE");
      }) as unknown as typeof fetch,
      maxBytes: 10_000,
    }),
    (error: unknown) =>
      error instanceof WhatsAppMediaDownloadError &&
      error.code === "MEDIA_NOT_FOUND",
  );
  assert.equal(called, false);
});

test("rechaza un host de descarga ajeno a Meta", async () => {
  await assert.rejects(
    downloadInboundWhatsAppMedia({
      client: credentialClient(),
      message: audioMessage(),
      fetchImpl: graphFetch({
        information: {
          id: MEDIA_ID,
          messaging_product: "whatsapp",
          url: "https://evil.example.com/media",
          mime_type: "audio/ogg",
          file_size: 2048,
        },
      }),
      maxBytes: 10_000,
    }),
    WhatsAppMediaValidationError,
  );
});

test("rechaza un cuerpo cuyo tipo real no es el declarado", async () => {
  await assert.rejects(
    downloadInboundWhatsAppMedia({
      client: credentialClient(),
      message: audioMessage(),
      fetchImpl: graphFetch({ mediaContentType: "text/html" }),
      maxBytes: 10_000,
    }),
    WhatsAppMediaValidationError,
  );
});

test("corta una descarga que excede el límite configurado", async () => {
  await assert.rejects(
    downloadInboundWhatsAppMedia({
      client: credentialClient(),
      message: audioMessage(),
      fetchImpl: graphFetch({ body: new Uint8Array(4096) }),
      maxBytes: 1024,
    }),
    WhatsAppMediaValidationError,
  );
});

test("un comprobante sigue validando su MIME contra la lista permitida", async () => {
  const document = audioMessage({
    type: "document",
    metadata: {
      media_id: MEDIA_ID,
      mime_type: "application/pdf",
      filename: "transferencia.pdf",
    },
  });
  const result = await downloadInboundWhatsAppMedia({
    client: credentialClient(),
    message: document,
    fetchImpl: graphFetch({
      information: {
        id: MEDIA_ID,
        messaging_product: "whatsapp",
        url: DOWNLOAD_URL,
        mime_type: "application/pdf",
        file_size: 2048,
      },
      mediaContentType: "application/pdf",
    }),
    maxBytes: 10_000,
  });
  assert.equal(result.descriptor.filename, "transferencia.pdf");

  await assert.rejects(
    downloadInboundWhatsAppMedia({
      client: credentialClient(),
      message: document,
      fetchImpl: graphFetch({
        information: {
          id: MEDIA_ID,
          messaging_product: "whatsapp",
          url: DOWNLOAD_URL,
          mime_type: "application/x-msdownload",
          file_size: 2048,
        },
        mediaContentType: "application/x-msdownload",
      }),
      maxBytes: 10_000,
    }),
    WhatsAppMediaValidationError,
  );
});
