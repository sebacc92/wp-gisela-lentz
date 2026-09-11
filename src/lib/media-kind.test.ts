import assert from "node:assert/strict";
import test from "node:test";
import { mediaKind, mediaKindLabel } from "./media-kind.ts";

test("el MIME real manda sobre el tipo del mensaje", () => {
  assert.equal(
    mediaKind({ messageType: "document", mimeType: "image/jpeg" }),
    "image",
    "un comprobante mandado como documento sigue siendo una imagen",
  );
  assert.equal(
    mediaKind({ messageType: "image", mimeType: "application/pdf" }),
    "pdf",
  );
});

test("reconoce los formatos que se pueden mostrar", () => {
  assert.equal(mediaKind({ mimeType: "image/png" }), "image");
  assert.equal(mediaKind({ mimeType: "application/pdf" }), "pdf");
  assert.equal(mediaKind({ mimeType: "audio/ogg" }), "audio");
});

test("sin MIME confiable cae al tipo del mensaje", () => {
  assert.equal(mediaKind({ messageType: "image", mimeType: "" }), "image");
  assert.equal(
    mediaKind({ messageType: "audio", mimeType: "application/octet-stream" }),
    "audio",
  );
});

test("un adjunto desconocido no se incrusta", () => {
  assert.equal(
    mediaKind({ messageType: "document", mimeType: "application/zip" }),
    "other",
  );
  assert.equal(mediaKind({ messageType: "document", mimeType: "" }), "other");
});

test("cada tipo tiene un nombre legible", () => {
  assert.equal(mediaKindLabel("pdf"), "Documento PDF");
  assert.equal(mediaKindLabel("other"), "Archivo");
});
