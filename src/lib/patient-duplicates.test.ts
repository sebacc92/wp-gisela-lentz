import assert from "node:assert/strict";
import test from "node:test";
import {
  findDuplicatePairs,
  mergeBlock,
  normalizeName,
  type DuplicateCandidateInput,
} from "./patient-duplicates.ts";

function patient(
  overrides: Partial<DuplicateCandidateInput> = {},
): DuplicateCandidateInput {
  return {
    id: Math.random().toString(36).slice(2),
    name: "Ana Gómez",
    phoneE164: "+5492211234567",
    alternatePhoneE164: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    appointmentCount: 0,
    hasClinicalHistory: false,
    ...overrides,
  };
}

test("el nombre se normaliza sin acentos ni puntuación", () => {
  assert.equal(normalizeName("  Ana  GÓMEZ.  "), "ana gomez");
});

test("el mismo teléfono es la señal más fuerte", () => {
  const [pair] = findDuplicatePairs([
    patient({ id: "a", name: "Ana Gómez" }),
    patient({ id: "b", name: "Ana G." }),
  ]);
  assert.equal(pair.reason, "same_phone");
  assert.ok(pair.confidence >= 90);
});

test("el teléfono se compara por los últimos dígitos", () => {
  const pairs = findDuplicatePairs([
    patient({ id: "a", phoneE164: "+542211234567" }),
    patient({ id: "b", phoneE164: "+5492211234567", name: "Otra Persona" }),
  ]);
  assert.equal(
    pairs.length,
    1,
    "el 9 de Argentina no debería separar la ficha",
  );
});

test("también mira el teléfono alternativo", () => {
  const pairs = findDuplicatePairs([
    patient({ id: "a", phoneE164: "+5492211111111", name: "Uno" }),
    patient({
      id: "b",
      phoneE164: "+5492222222222",
      alternatePhoneE164: "+5492211111111",
      name: "Dos",
    }),
  ]);
  assert.equal(pairs[0].reason, "same_phone");
});

test("mismo nombre sin teléfono compartido tiene menos confianza", () => {
  const [pair] = findDuplicatePairs([
    patient({ id: "a", phoneE164: "+5492211111111" }),
    patient({ id: "b", phoneE164: "+5492222222222" }),
  ]);
  assert.equal(pair.reason, "same_name");
  assert.ok(pair.confidence < 90);
});

test("reconoce el nombre con las palabras invertidas", () => {
  const [pair] = findDuplicatePairs([
    patient({ id: "a", name: "Ana Gómez", phoneE164: "+5492211111111" }),
    patient({ id: "b", name: "Gómez Ana", phoneE164: "+5492222222222" }),
  ]);
  assert.equal(pair.reason, "similar_name");
});

test("dos pacientes distintos no se proponen", () => {
  assert.deepEqual(
    findDuplicatePairs([
      patient({ id: "a", name: "Ana Gómez", phoneE164: "+5492211111111" }),
      patient({ id: "b", name: "Carlos Pérez", phoneE164: "+5492222222222" }),
    ]),
    [],
  );
});

test("conserva la ficha con más turnos", () => {
  const [pair] = findDuplicatePairs([
    patient({ id: "pocos", appointmentCount: 1 }),
    patient({ id: "muchos", appointmentCount: 7 }),
  ]);
  assert.equal(pair.primary.id, "muchos");
  assert.equal(pair.duplicate.id, "pocos");
});

test("a igualdad de turnos conserva la más antigua", () => {
  const [pair] = findDuplicatePairs([
    patient({ id: "nueva", createdAt: "2026-06-01T00:00:00.000Z" }),
    patient({ id: "vieja", createdAt: "2025-01-01T00:00:00.000Z" }),
  ]);
  assert.equal(pair.primary.id, "vieja");
});

test("una ficha con odontograma no se fusiona desde el panel", () => {
  const [pair] = findDuplicatePairs([
    patient({ id: "a", appointmentCount: 5 }),
    patient({ id: "b", hasClinicalHistory: true }),
  ]);
  const block = mergeBlock(pair);
  assert.equal(block.blocked, true);
  assert.match(block.reason ?? "", /historia clínica|odontograma/i);
});

test("una fusión administrativa común no se bloquea", () => {
  const [pair] = findDuplicatePairs([
    patient({ id: "a", appointmentCount: 5 }),
    patient({ id: "b" }),
  ]);
  assert.equal(mergeBlock(pair).blocked, false);
});

test("los resultados se ordenan por confianza", () => {
  const pairs = findDuplicatePairs([
    patient({ id: "a", name: "Ana Gómez", phoneE164: "+5491111111111" }),
    patient({ id: "b", name: "Ana Gómez", phoneE164: "+5492222222222" }),
    patient({ id: "c", name: "Ana Gómez", phoneE164: "+5491111111111" }),
  ]);
  assert.ok(pairs[0].confidence >= pairs[pairs.length - 1].confidence);
});

test("un teléfono corto o ausente no genera coincidencia por teléfono", () => {
  const pairs = findDuplicatePairs([
    patient({ id: "a", name: "Uno", phoneE164: null }),
    patient({ id: "b", name: "Dos", phoneE164: null }),
  ]);
  assert.deepEqual(pairs, [], "sin teléfono ni nombre igual no hay indicio");
});
