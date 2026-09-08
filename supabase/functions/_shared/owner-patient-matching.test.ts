import assert from "node:assert/strict";
import test from "node:test";

import {
  matchOwnerPatients,
  normalizePatientName,
  type OwnerPatientCandidate,
} from "./owner-patient-matching.ts";

const matias = { id: "matias", name: "Matias Icardo" };
const directory = [
  matias,
  { id: "ana", name: "Ana María Pérez" },
  { id: "mariana", name: "Mariana Gómez" },
  { id: "matias-lopez", name: "Matías López" },
];

test("normaliza acentos NFC/NFD, mayúsculas, espacios y separadores de nombres", () => {
  for (const [input, expected] of [
    ["  MATÍAS   Icardo  ", "matias icardo"],
    ["Mati\u0301as Icardo", "matias icardo"],
    ["ÁÉÍÓÚ Ü Ñ", "aeiou u n"],
    ["Ana O’Connor-López", "ana oconnor lopez"],
    ["Pérez, Ana", "perez ana"],
  ]) assert.equal(normalizePatientName(input), expected, input);
});

test("Matías con o sin acento y con apellido primero coincide sin sugerencias", () => {
  for (const query of [
    "Matías Icardo",
    "Mati\u0301as Icardo",
    "MATIAS ICARDO",
    "  Matías   Icardo ",
    "Icardo Matías",
    "Icardo, Matías",
    "Icardo",
  ]) {
    assert.deepEqual(matchOwnerPatients(query, directory), {
      kind: "exact",
      candidates: [matias],
    }, query);
  }
});

test("errores pequeños sólo sugieren: nunca devuelven coincidencia exacta", () => {
  for (const query of [
    "Matias Icrado",
    "Matis Icardo",
    "Matias Icrdo",
    "Matias Icard",
    "Matis Icrado",
    "Icrado Matías",
    "Icrado",
  ]) {
    assert.deepEqual(matchOwnerPatients(query, directory), {
      kind: "suggestions",
      candidates: [matias],
    }, query);
  }
});

test("nombres parciales son tokens completos y mantienen las ambigüedades", () => {
  assert.deepEqual(matchOwnerPatients("Ana", directory), {
    kind: "exact",
    candidates: [directory[1]],
  });
  assert.deepEqual(matchOwnerPatients("Matias", directory), {
    kind: "exact",
    candidates: [matias, directory[3]],
  });
  assert.deepEqual(matchOwnerPatients("Pérez Ana", directory), {
    kind: "exact",
    candidates: [directory[1]],
  });
  for (const query of ["Ica", "Icar", "Matías Ica", "Ana Ana"]) {
    assert.deepEqual(matchOwnerPatients(query, directory), {
      kind: "none",
      candidates: [],
    }, query);
  }
  assert.deepEqual(matchOwnerPatients("Ana", [directory[2]!]), {
    kind: "none",
    candidates: [],
  });
});

test("no confunde nombres cortos ni descarta apellidos que no coinciden", () => {
  for (const query of [
    "Matias Fernández",
    "Ana Icardo",
    "An Pérez",
    "Ani Pérez",
    "Luis Icardo",
    "Carlos Gómez",
    "Matias Icardo Pérez",
  ]) {
    assert.deepEqual(matchOwnerPatients(query, directory), {
      kind: "none",
      candidates: [],
    }, query);
  }
});

test("colisiones de acentos y contactos con el mismo nombre siguen ambiguos", () => {
  const duplicate = { id: "otro-matias", name: "Matías Icardo" };
  assert.deepEqual(matchOwnerPatients("Matias Icardo", [matias, duplicate]), {
    kind: "exact",
    candidates: [matias, duplicate],
  });
  assert.deepEqual(matchOwnerPatients("Matías Icardo", [matias, matias]), {
    kind: "exact",
    candidates: [matias],
  });
  assert.deepEqual(matchOwnerPatients("Matias Icrado", [matias, duplicate]), {
    kind: "suggestions",
    candidates: [matias, duplicate],
  });
});

test("las coincidencias exactas ganan sin añadir aproximaciones", () => {
  const literal = { id: "literal", name: "Matias Icrado" };
  assert.deepEqual(matchOwnerPatients("Matias Icrado", [matias, literal]), {
    kind: "exact",
    candidates: [literal],
  });
});

test("tolera dos errores sólo en tokens largos y mantiene un límite total", () => {
  const longName = { id: "long", name: "Gabriela Fernández" };
  assert.deepEqual(matchOwnerPatients("Gabriela Farnandes", [longName]), {
    kind: "suggestions",
    candidates: [longName],
  });
  for (const query of ["Gabrilea Farnandes", "Gabriela Farmincas"]) {
    assert.deepEqual(matchOwnerPatients(query, [longName]), {
      kind: "none",
      candidates: [],
    }, query);
  }
});

test("sugiere hasta cinco opciones ordenadas por distancia, con desempate estable", () => {
  const candidates: OwnerPatientCandidate[] = [
    { id: "two", name: "Matis Icrado" },
    { id: "extra", name: "Matias Juan Icrado" },
    ...Array.from({ length: 6 }, (_, index) => ({
      id: `one-${index}`,
      name: "Matias Icrado",
    })),
  ];
  assert.deepEqual(matchOwnerPatients("Matias Icardo", candidates), {
    kind: "suggestions",
    candidates: candidates.slice(2, 7),
  });
  assert.deepEqual(matchOwnerPatients("Matias Icardo", candidates.slice(0, 3)), {
    kind: "suggestions",
    candidates: [candidates[2], candidates[1], candidates[0]],
  });
});

test("acota y valida entradas sin mutar ni exponer campos adicionales", () => {
  for (const query of [
    "",
    " ",
    "A",
    "-.'",
    "Matias%",
    "Matias 123",
    "Matias; DROP TABLE contacts",
    "😀 Icardo",
    "A".repeat(61),
    Array.from({ length: 11 }, () => "Ana").join(" "),
  ]) {
    assert.deepEqual(matchOwnerPatients(query, directory), {
      kind: "none",
      candidates: [],
    }, query);
  }
  const snapshot = structuredClone(directory);
  matchOwnerPatients("Matis Icardo", directory);
  assert.deepEqual(directory, snapshot);
  const candidateWithExtraFields = {
    ...matias,
    phone_e164: "+5491112345678",
    notes: "No copiar notas ni datos administrativos en las sugerencias",
  };
  assert.deepEqual(matchOwnerPatients("Matis Icardo", [candidateWithExtraFields]), {
    kind: "suggestions",
    candidates: [matias],
  });
  assert.deepEqual(matchOwnerPatients("Matias", [
    { id: "", name: "Matias" },
    { id: "invalid", name: "Matias 123" },
    { id: "long", name: `Matias ${"A".repeat(200)}` },
  ]), { kind: "none", candidates: [] });
});
