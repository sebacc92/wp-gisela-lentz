import assert from "node:assert/strict";
import test from "node:test";
import {
  escapeLikePattern,
  messageSearchPattern,
  messageSnippet,
} from "./message-search.ts";

test("los comodines de SQL se escapan", () => {
  assert.equal(escapeLikePattern("50% off"), "50\\% off");
  assert.equal(escapeLikePattern("turno_1"), "turno\\_1");
  assert.equal(escapeLikePattern("a\\b"), "a\\\\b");
});

test("una búsqueda muy corta no busca nada", () => {
  assert.equal(messageSearchPattern("ab"), null);
  assert.equal(messageSearchPattern("   "), null);
});

test("el patrón envuelve el texto ya escapado", () => {
  assert.equal(messageSearchPattern("  seña  "), "%seña%");
  assert.equal(messageSearchPattern("100%"), "%100\\%%");
});

test("el recorte muestra el contexto alrededor de la coincidencia", () => {
  const body = `${"a".repeat(200)} comprobante ${"b".repeat(200)}`;
  const snippet = messageSnippet(body, "comprobante");
  assert.match(snippet, /comprobante/);
  assert.ok(snippet.startsWith("…"), "recorta antes");
  assert.ok(snippet.endsWith("…"), "recorta después");
  assert.ok(snippet.length < body.length);
});

test("un mensaje corto se muestra entero", () => {
  assert.equal(messageSnippet("Gracias!", "gracias"), "Gracias!");
});

test("el recorte no depende de mayúsculas ni de saltos de línea", () => {
  assert.equal(messageSnippet("Hola\n\n  MUNDO  ", "mundo"), "Hola MUNDO");
});

test("si no encuentra la coincidencia igual devuelve algo legible", () => {
  const snippet = messageSnippet("a".repeat(500), "zzz");
  assert.ok(snippet.endsWith("…"));
  assert.ok(snippet.length <= 121);
});
