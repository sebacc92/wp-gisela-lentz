import assert from "node:assert/strict";
import test from "node:test";
import { attachmentRejection, formatBytes } from "./attachment-format.ts";

test("el tamaño se muestra en la unidad que corresponde", () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(2048), "2 KB");
  assert.equal(formatBytes(3 * 1024 * 1024), "3.0 MB");
  assert.equal(formatBytes(0), "0 KB");
});

test("acepta los formatos que el visor sabe mostrar", () => {
  for (const type of ["image/jpeg", "image/png", "application/pdf"]) {
    assert.equal(attachmentRejection({ type, size: 1000 }), null);
  }
});

test("rechaza un formato que no se puede mostrar", () => {
  assert.match(
    attachmentRejection({ type: "application/zip", size: 1000 }) ?? "",
    /JPG o PNG y archivos PDF/,
  );
});

test("rechaza un archivo vacío", () => {
  assert.match(
    attachmentRejection({ type: "image/png", size: 0 }) ?? "",
    /vacío/,
  );
});

test("rechaza un archivo demasiado grande", () => {
  assert.match(
    attachmentRejection({ type: "image/png", size: 30 * 1024 * 1024 }) ?? "",
    /supera/,
  );
});
