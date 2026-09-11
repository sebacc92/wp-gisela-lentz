import assert from "node:assert/strict";
import test from "node:test";
import {
  accentInsensitivePattern,
  foldForSearch,
  messageSnippet,
} from "./message-search.ts";

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

test("el patrón ignora acentos en ambas direcciones", () => {
  const pattern = accentInsensitivePattern("Lopez");
  assert.ok(pattern);
  const regex = new RegExp(pattern, "i");
  assert.match("María López", regex, "sin tilde encuentra con tilde");
  assert.match("Maria Lopez", regex);
  const withAccent = new RegExp(accentInsensitivePattern("López") ?? "", "i");
  assert.match("Maria Lopez", withAccent, "con tilde encuentra sin tilde");
});

test("la eñe se encuentra escribiendo n", () => {
  const regex = new RegExp(accentInsensitivePattern("Nunez") ?? "", "i");
  assert.match("Núñez", regex);
});

test("el patrón no deja pasar caracteres especiales", () => {
  const pattern = accentInsensitivePattern("Pérez (hija), 50%");
  assert.ok(pattern);
  // Sólo clases, letras, dígitos y el espacio entre corchetes.
  assert.doesNotMatch(pattern, /[(),%.*+?^$|\\]/);
});

test("una búsqueda muy corta no arma patrón", () => {
  assert.equal(accentInsensitivePattern("a"), null);
  assert.equal(accentInsensitivePattern("  "), null);
});

test("los espacios de más no rompen la coincidencia", () => {
  const regex = new RegExp(
    accentInsensitivePattern("maria   lopez") ?? "",
    "i",
  );
  assert.match("María López", regex);
});

test("plegar conserva la longitud, también con emojis", () => {
  for (const value of ["Pérez", "Núñez 😊 señá", "¡Hola! 👋"]) {
    assert.equal(foldForSearch(value).length, value.length, value);
  }
  assert.equal(foldForSearch("Pérez"), "perez");
});

test("el recorte encuentra la palabra aunque se busque sin tilde", () => {
  const body = `${"x".repeat(80)} te pido la seña del turno ${"y".repeat(80)}`;
  const snippet = messageSnippet(body, "sena");
  assert.match(
    snippet,
    /seña/,
    "recorta alrededor de «seña», no del principio",
  );
  assert.ok(snippet.startsWith("…"));
});

test("el recorte no se corre de lugar después de un emoji", () => {
  const body = `${"😊".repeat(40)} comprobante ${"z".repeat(90)}`;
  assert.match(messageSnippet(body, "comprobante"), /comprobante/);
});
