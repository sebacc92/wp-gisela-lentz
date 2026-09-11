import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  HUMAN_REVIEW_PATTERN,
  OPT_IN_PHRASES,
  OPT_OUT_PHRASES,
  PRIORITY_PATTERN,
  normalizedPhrase,
} from "./bot-playground.ts";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

/**
 * El simulador del panel repite las reglas de ruteo que aplica la function en
 * Deno. Si alguien cambia una y no la otra, el panel mentiría sobre lo que
 * hace el bot. Estos contratos existen para que esa divergencia falle en CI.
 */
const INCOMING = "supabase/functions/_shared/incoming-message.ts";

function phraseSet(name: string, text: string): Set<string> {
  const start = text.indexOf(`const ${name} = new Set([`);
  assert.ok(start > 0, `no se encontró ${name} en la function`);
  const end = text.indexOf("]);", start);
  return new Set(
    Array.from(text.slice(start, end).matchAll(/"([^"]*)"/g), (m) => m[1]),
  );
}

test("la regla de urgencias del simulador es la de la function", () => {
  const incoming = source(INCOMING);
  assert.ok(
    incoming.includes(PRIORITY_PATTERN.source),
    "la expresión de prioridad del simulador ya no aparece en la function",
  );
});

test("la regla de derivación clínica del simulador es la de la function", () => {
  const incoming = source(INCOMING);
  assert.ok(
    incoming.includes(HUMAN_REVIEW_PATTERN.source),
    "la expresión de revisión humana del simulador ya no aparece en la function",
  );
});

test("las frases de baja y de alta coinciden exactamente", () => {
  const incoming = source(INCOMING);
  assert.deepEqual(
    [...OPT_OUT_PHRASES].sort(),
    [...phraseSet("OPT_OUT_PHRASES", incoming)].sort(),
  );
  assert.deepEqual(
    [...OPT_IN_PHRASES].sort(),
    [...phraseSet("OPT_IN_PHRASES", incoming)].sort(),
  );
});

test("la normalización de frases sigue el mismo procedimiento", () => {
  const incoming = source(INCOMING);
  // Mismo encadenado: sin acentos, minúsculas es-AR, sólo alfanumérico.
  assert.match(incoming, /\.replace\(\/\[\\u0300-\\u036f\]\/g, ""\)/);
  assert.match(incoming, /\.toLocaleLowerCase\("es-AR"\)/);
  assert.match(incoming, /\.replace\(\/\[\^a-z0-9\]\+\/g, " "\)/);
  // Y el resultado coincide sobre un caso con acentos y puntuación.
  assert.equal(
    normalizedPhrase("¡Tengo DOLOR intenso!"),
    "tengo dolor intenso",
  );
});

test("los adjuntos opacos siguen derivando a una persona", () => {
  const incoming = source(INCOMING);
  assert.match(
    incoming,
    /message\.type === "image" \|\|\s*message\.type === "document" \|\|\s*message\.type === "audio"/,
  );
});
