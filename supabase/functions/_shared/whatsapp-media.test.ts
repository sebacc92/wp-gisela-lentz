import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_WHATSAPP_MEDIA_MAX_BYTES,
  assertWhatsAppMediaResponseType,
  isAllowedWhatsAppMediaDownloadUrl,
  isValidMessageUuid,
  readBodyWithLimit,
  resolveWhatsAppMediaDescriptor,
  safeWhatsAppMediaFilename,
  whatsappMediaMaxBytes,
} from "./whatsapp-media.ts";

const messageId = "4b5f6b87-c542-4703-820b-b27794ad471d";

test("valida UUID, límite fail-safe y host exacto de Meta", () => {
  assert.equal(isValidMessageUuid(messageId), true);
  assert.equal(isValidMessageUuid("../../secreto"), false);
  assert.equal(
    whatsappMediaMaxBytes(undefined),
    DEFAULT_WHATSAPP_MEDIA_MAX_BYTES,
  );
  assert.equal(whatsappMediaMaxBytes("1048576"), 1_048_576);
  assert.equal(
    whatsappMediaMaxBytes("999999999"),
    DEFAULT_WHATSAPP_MEDIA_MAX_BYTES,
  );
  assert.equal(
    isAllowedWhatsAppMediaDownloadUrl(
      "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1",
    ),
    true,
  );
  assert.equal(
    isAllowedWhatsAppMediaDownloadUrl(
      "https://lookaside.fbsbx.com.evil.test/whatsapp_business/attachments/",
    ),
    false,
  );
  assert.equal(
    isAllowedWhatsAppMediaDownloadUrl("http://lookaside.fbsbx.com/file"),
    false,
  );
});

test("acepta sólo media entrante, ID coincidente, MIME seguro y tamaño acotado", () => {
  assert.deepEqual(
    resolveWhatsAppMediaDescriptor({
      messageDirection: "inbound",
      messageType: "document",
      metadata: {
        media_id: "1234567890",
        mime_type: "application/pdf",
        filename: 'transferencia\r\nX-Evil: "sí".exe',
      },
      graphMediaId: "1234567890",
      graphMimeType: "application/pdf",
      graphFileSize: "4000",
      maxBytes: 5000,
    }),
    {
      type: "document",
      mediaId: "1234567890",
      mimeType: "application/pdf",
      filename: "transferenciaX-Evil sí.pdf",
      disposition: "inline",
    },
  );

  for (const override of [
    { messageDirection: "outbound" },
    { messageType: "text" },
    { graphMediaId: "9999999999" },
    { graphMimeType: "text/html" },
    { graphFileSize: "5001" },
  ]) {
    assert.throws(() =>
      resolveWhatsAppMediaDescriptor({
        messageDirection: "inbound",
        messageType: "image",
        metadata: { media_id: "1234567890", mime_type: "image/jpeg" },
        graphMediaId: "1234567890",
        graphMimeType: "image/jpeg",
        graphFileSize: "4000",
        maxBytes: 5000,
        ...override,
      }),
    );
  }
});

test("sanitiza nombre y verifica el MIME real de la respuesta", () => {
  assert.equal(
    safeWhatsAppMediaFilename("../pago.PDF", "application/pdf"),
    "pago.pdf",
  );
  assert.doesNotThrow(() =>
    assertWhatsAppMediaResponseType("image/png; charset=binary", "image/png"),
  );
  assert.throws(() =>
    assertWhatsAppMediaResponseType("text/html", "image/png"),
  );
});

test("corta el stream aunque Content-Length mienta", async () => {
  const valid = new Response(new Uint8Array([1, 2, 3]), {
    headers: { "content-length": "3" },
  });
  assert.deepEqual(
    await readBodyWithLimit(valid, 3),
    new Uint8Array([1, 2, 3]),
  );

  const oversized = new Response(new Uint8Array([1, 2, 3, 4]));
  await assert.rejects(() => readBodyWithLimit(oversized, 3));
});

test("acepta una nota de voz y la nombra como audio, no como comprobante", () => {
  assert.deepEqual(
    resolveWhatsAppMediaDescriptor({
      messageDirection: "inbound",
      messageType: "audio",
      metadata: { media_id: "1234567890", mime_type: "audio/ogg" },
      graphMediaId: "1234567890",
      // WhatsApp anuncia las notas de voz con el códec en el mismo header.
      graphMimeType: "audio/ogg; codecs=opus",
      graphFileSize: "4000",
      maxBytes: 5000,
    }),
    {
      type: "audio",
      mediaId: "1234567890",
      mimeType: "audio/ogg",
      filename: "audio.ogg",
      disposition: "inline",
    },
  );

  assert.equal(safeWhatsAppMediaFilename(undefined, "audio/mpeg"), "audio.mp3");

  for (const override of [
    { graphMimeType: "audio/x-wav" },
    { graphMimeType: "application/pdf" },
    { messageType: "video" },
  ]) {
    assert.throws(() =>
      resolveWhatsAppMediaDescriptor({
        messageDirection: "inbound",
        messageType: "audio",
        metadata: { media_id: "1234567890", mime_type: "audio/ogg" },
        graphMediaId: "1234567890",
        graphMimeType: "audio/ogg",
        graphFileSize: "4000",
        maxBytes: 5000,
        ...override,
      }),
    );
  }
});
