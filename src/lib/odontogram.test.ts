import assert from "node:assert/strict";
import test from "node:test";

import {
  ALL_TEETH,
  LOWER_PERMANENT,
  LOWER_PRIMARY,
  UPPER_PERMANENT,
  UPPER_PRIMARY,
  conditionAllowsSurfaces,
  currentByTooth,
  isAnteriorTooth,
  isPrimaryTooth,
  isUpperTooth,
  isValidTooth,
  surfaceLabel,
  toothSummary,
  type OdontogramEntry,
} from "./odontogram.ts";

function entry(overrides: Partial<OdontogramEntry> = {}): OdontogramEntry {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    contactId: "22222222-2222-4222-8222-222222222222",
    tooth: 16,
    condition: "caries",
    surfaces: { oclusal: "caries" },
    note: null,
    recordedAt: "2026-08-30T10:00:00.000Z",
    entrySequence: 1,
    ...overrides,
  };
}

test("la numeración FDI cubre permanentes y temporarias sin repetir piezas", () => {
  assert.equal(UPPER_PERMANENT.length, 16);
  assert.equal(LOWER_PERMANENT.length, 16);
  assert.equal(UPPER_PRIMARY.length, 10);
  assert.equal(LOWER_PRIMARY.length, 10);
  assert.equal(ALL_TEETH.length, 52);
  assert.equal(new Set(ALL_TEETH).size, 52, "no debe haber piezas repetidas");

  for (const tooth of ALL_TEETH) assert.equal(isValidTooth(tooth), true);
  // Números que no existen en FDI.
  for (const tooth of [0, 10, 19, 20, 29, 39, 49, 50, 56, 66, 76, 86, 99]) {
    assert.equal(isValidTooth(tooth), false, String(tooth));
  }
});

test("cada fila abre por el lado derecho del paciente", () => {
  // Frente al paciente, a la izquierda de la pantalla queda su hemiarcada
  // derecha: la fila superior empieza en 18 y cruza la línea media en 21.
  assert.equal(UPPER_PERMANENT[0], 18);
  assert.equal(UPPER_PERMANENT[7], 11);
  assert.equal(UPPER_PERMANENT[8], 21);
  assert.equal(LOWER_PERMANENT[0], 48);
  assert.equal(LOWER_PERMANENT[8], 31);
});

test("distingue arcada y dentición", () => {
  assert.equal(isUpperTooth(16), true);
  assert.equal(isUpperTooth(26), true);
  assert.equal(isUpperTooth(36), false);
  assert.equal(isUpperTooth(46), false);
  assert.equal(isUpperTooth(55), true);
  assert.equal(isUpperTooth(85), false);

  assert.equal(isPrimaryTooth(16), false);
  assert.equal(isPrimaryTooth(51), true);
  assert.equal(isPrimaryTooth(85), true);
});

test("la cara interna se llama palatina arriba y lingual abajo", () => {
  assert.equal(surfaceLabel(16, "palatina_lingual"), "Palatina");
  assert.equal(surfaceLabel(46, "palatina_lingual"), "Lingual");
  assert.equal(surfaceLabel(61, "palatina_lingual"), "Palatina");
  assert.equal(surfaceLabel(71, "palatina_lingual"), "Lingual");
  assert.equal(surfaceLabel(16, "oclusal"), "Oclusal");
});

test("sólo los hallazgos localizables admiten caras", () => {
  for (const condition of [
    "caries",
    "obturado",
    "sellante",
    "fracturado",
    "endodoncia",
    "corona",
    "extraccion_indicada",
  ] as const) {
    assert.equal(conditionAllowsSurfaces(condition), true, condition);
  }
  // Coincide con el check de la base: una pieza que no está no tiene caras.
  for (const condition of [
    "ausente",
    "implante",
    "protesis",
    "sano",
  ] as const) {
    assert.equal(conditionAllowsSurfaces(condition), false, condition);
  }
});

test("el resumen de una pieza nombra la condición y sus caras", () => {
  assert.equal(toothSummary(undefined), "Sin registrar");
  assert.equal(
    toothSummary(entry({ condition: "ausente", surfaces: {} })),
    "Ausente",
  );
  assert.equal(
    toothSummary(
      entry({ tooth: 46, surfaces: { palatina_lingual: "caries" } }),
    ),
    "Caries · Lingual",
  );
});

test("el estado vigente de una pieza es su último asiento", () => {
  const history = [
    entry({ id: "a", condition: "caries", recordedAt: "2026-08-01T10:00:00Z" }),
    entry({
      id: "b",
      condition: "obturado",
      surfaces: { oclusal: "obturado" },
      recordedAt: "2026-08-20T10:00:00Z",
      entrySequence: 2,
    }),
    entry({ id: "c", tooth: 21, condition: "sano", surfaces: {} }),
  ];
  const current = currentByTooth(history);

  assert.equal(current.get(16)?.condition, "obturado");
  assert.equal(current.get(21)?.condition, "sano");
  assert.equal(current.size, 2, "una corrección no agrega una pieza nueva");
});

test("la secuencia del servidor define el estado aunque la fecha o la llegada cambien", () => {
  const latest = entry({
    id: "latest",
    entrySequence: 3,
    condition: "obturado",
  });
  const older = entry({
    id: "older",
    entrySequence: 2,
    recordedAt: "2026-09-01T10:00:00Z",
  });
  assert.equal(currentByTooth([latest, older]).get(16)?.id, "latest");
  assert.equal(currentByTooth([older, latest]).get(16)?.id, "latest");
  assert.equal(
    currentByTooth([latest, entry({ entrySequence: 1 })]).get(16)?.id,
    "latest",
  );
});

test("el resumen conserva hallazgos diferentes en cada cara", () => {
  assert.equal(
    toothSummary(
      entry({ surfaces: { distal: "obturado", oclusal: "caries" } }),
    ),
    "Caries · Oclusal, Distal: Obturada",
  );
});

test("las piezas anteriores tienen borde incisal, no cara oclusal", () => {
  // Incisivos y caninos: posiciones 1 a 3 de cada cuadrante.
  for (const tooth of [11, 12, 13, 23, 31, 43, 51, 63, 83]) {
    assert.equal(
      surfaceLabel(tooth, "oclusal"),
      "Incisal",
      `la pieza ${tooth} es anterior`,
    );
    assert.equal(isAnteriorTooth(tooth), true);
  }
});

test("premolares y molares conservan la cara oclusal", () => {
  for (const tooth of [14, 16, 18, 26, 37, 48, 54, 65, 75]) {
    assert.equal(
      surfaceLabel(tooth, "oclusal"),
      "Oclusal",
      `la pieza ${tooth} es posterior`,
    );
    assert.equal(isAnteriorTooth(tooth), false);
  }
});

test("el nombre de la cara interna sigue dependiendo de la arcada", () => {
  assert.equal(surfaceLabel(11, "palatina_lingual"), "Palatina");
  assert.equal(surfaceLabel(41, "palatina_lingual"), "Lingual");
});
