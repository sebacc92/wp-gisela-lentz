import assert from "node:assert/strict";
import test from "node:test";
import { ALL_TEETH, ALL_SURFACES } from "./odontogram.ts";
import {
  conditionNotation,
  hasUnlocalizedFinding,
  NOTATION_COLORS,
  toothDiagramFaces,
} from "./odontogram-notation.ts";

test("las cuatro referencias de Gisela distinguen color y símbolo", () => {
  assert.equal(conditionNotation("caries").tone, "blue");
  assert.equal(conditionNotation("obturado").tone, "red");
  assert.equal(conditionNotation("obturado").symbol, "restoration");
  assert.equal(conditionNotation("extraccion_indicada").tone, "blue");
  assert.equal(conditionNotation("extraccion_indicada").symbol, "extraction");
  assert.equal(conditionNotation("ausente").tone, "blue");
  assert.equal(conditionNotation("ausente").symbol, "missing");
  assert.notEqual(NOTATION_COLORS.blue, NOTATION_COLORS.red);
});

test("la notación no convierte piezas sin registrar en sanas ni infiere tratamientos", () => {
  assert.equal(conditionNotation().symbol, "unrecorded");
  assert.equal(conditionNotation("sano").symbol, "healthy");
  for (const condition of [
    "corona",
    "protesis",
    "implante",
    "endodoncia",
    "sellante",
    "fracturado",
  ] as const) {
    assert.equal(conditionNotation(condition).tone, "neutral");
    assert.equal(conditionNotation(condition).symbol, "label");
  }
});

test("las 52 piezas conservan las cinco caras sin inventar hallazgos", () => {
  for (const tooth of ALL_TEETH) {
    const faces = toothDiagramFaces(tooth);
    assert.equal(faces.length, 5);
    assert.deepEqual(
      faces.map((face) => face.surface).sort(),
      [...ALL_SURFACES].sort(),
    );
    assert.ok(faces.every((face) => face.condition === undefined));
    assert.deepEqual(
      faces.find((face) => face.surface === "oclusal"),
      {
        surface: "oclusal",
        points: "30,30 70,30 70,70 30,70",
        cx: 50,
        cy: 50,
        condition: undefined,
      },
    );
  }
  for (const invalid of [0, 19, 29, 59, 99]) {
    assert.throws(() => toothDiagramFaces(invalid), /INVALID_TOOTH/);
  }
});

test("mesial apunta a la línea media en ambos lados y ambas denticiones", () => {
  for (const tooth of [11, 18, 41, 48, 51, 55, 81, 85]) {
    const mesial = toothDiagramFaces(tooth).find(
      (face) => face.surface === "mesial",
    )!;
    const distal = toothDiagramFaces(tooth).find(
      (face) => face.surface === "distal",
    )!;
    assert.ok(mesial.cx > 50, String(tooth));
    assert.ok(distal.cx < 50, String(tooth));
  }
  for (const tooth of [21, 28, 31, 38, 61, 65, 71, 75]) {
    const mesial = toothDiagramFaces(tooth).find(
      (face) => face.surface === "mesial",
    )!;
    const distal = toothDiagramFaces(tooth).find(
      (face) => face.surface === "distal",
    )!;
    assert.ok(mesial.cx < 50, String(tooth));
    assert.ok(distal.cx > 50, String(tooth));
  }
});

test("vestibular queda hacia afuera de cada arcada y palatina/lingual hacia adentro", () => {
  for (const tooth of [16, 26, 55, 65]) {
    assert.ok(
      toothDiagramFaces(tooth).find((face) => face.surface === "vestibular")!
        .cy < 50,
    );
    assert.ok(
      toothDiagramFaces(tooth).find(
        (face) => face.surface === "palatina_lingual",
      )!.cy > 50,
    );
  }
  for (const tooth of [36, 46, 75, 85]) {
    assert.ok(
      toothDiagramFaces(tooth).find((face) => face.surface === "vestibular")!
        .cy > 50,
    );
    assert.ok(
      toothDiagramFaces(tooth).find(
        (face) => face.surface === "palatina_lingual",
      )!.cy < 50,
    );
  }
});

test("caries y obturación coexistentes se dibujan en sus caras sin teñir las demás", () => {
  const surfaces = Object.freeze({
    oclusal: "caries",
    distal: "obturado",
  } as const);
  const faces = toothDiagramFaces(16, surfaces);
  assert.equal(faces.filter((face) => face.condition).length, 2);
  assert.equal(
    faces.find((face) => face.surface === "oclusal")!.condition,
    "caries",
  );
  assert.equal(
    faces.find((face) => face.surface === "distal")!.condition,
    "obturado",
  );
  assert.equal(
    faces.find((face) => face.surface === "mesial")!.condition,
    undefined,
  );
  assert.deepEqual(surfaces, { oclusal: "caries", distal: "obturado" });
});

test("una obturación distal no oculta una caries general sin localización", () => {
  assert.equal(hasUnlocalizedFinding("caries", {}), true);
  assert.equal(hasUnlocalizedFinding("caries", { distal: "obturado" }), true);
  assert.equal(
    hasUnlocalizedFinding("caries", { distal: "obturado", oclusal: "caries" }),
    false,
  );
  assert.equal(hasUnlocalizedFinding("obturado", { oclusal: "caries" }), true);
  assert.equal(
    hasUnlocalizedFinding("obturado", { distal: "obturado" }),
    false,
  );
  assert.equal(hasUnlocalizedFinding("ausente", {}), false);
  assert.equal(hasUnlocalizedFinding(undefined, {}), false);
});
