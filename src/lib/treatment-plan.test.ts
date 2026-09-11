import assert from "node:assert/strict";
import test from "node:test";
import {
  suggestTreatmentItems,
  treatmentPlanTotals,
  treatmentProgress,
  type TreatmentPlanItem,
} from "./treatment-plan.ts";

function item(overrides: Partial<TreatmentPlanItem> = {}): TreatmentPlanItem {
  return {
    id: Math.random().toString(36).slice(2),
    tooth: 16,
    description: "Obturación",
    estimatedCostArs: 10_000,
    status: "pending",
    note: null,
    completedAt: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

test("separa el presupuesto por estado", () => {
  const totals = treatmentPlanTotals([
    item({ status: "pending", estimatedCostArs: 10_000 }),
    item({ status: "in_progress", estimatedCostArs: 5_000 }),
    item({ status: "done", estimatedCostArs: 7_000 }),
  ]);
  assert.equal(totals.pendingArs, 10_000);
  assert.equal(totals.inProgressArs, 5_000);
  assert.equal(totals.doneArs, 7_000);
  assert.equal(totals.remainingArs, 15_000);
  assert.equal(totals.totalArs, 22_000);
});

test("un ítem cancelado no suma ni se reclama", () => {
  const totals = treatmentPlanTotals([
    item({ status: "cancelled", estimatedCostArs: 99_000 }),
  ]);
  assert.equal(totals.totalArs, 0);
  assert.equal(totals.counts.cancelled, 1);
});

test("los ítems sin precio se cuentan aparte, no como cero", () => {
  const totals = treatmentPlanTotals([
    item({ estimatedCostArs: null }),
    item({ estimatedCostArs: 8_000 }),
  ]);
  assert.equal(totals.totalArs, 8_000);
  assert.equal(totals.withoutCost, 1);
});

test("el avance ignora lo cancelado", () => {
  assert.equal(
    treatmentProgress([
      item({ status: "done" }),
      item({ status: "pending" }),
      item({ status: "cancelled" }),
    ]),
    50,
  );
});

test("sin plan activo el avance es desconocido, no cero", () => {
  assert.equal(treatmentProgress([]), null);
  assert.equal(treatmentProgress([item({ status: "cancelled" })]), null);
});

test("sugiere trabajo sólo para hallazgos que lo requieren", () => {
  const suggestions = suggestTreatmentItems([
    { tooth: 16, condition: "caries" },
    { tooth: 21, condition: "sano" },
    { tooth: 36, condition: "extraccion_indicada" },
  ]);
  assert.deepEqual(
    suggestions.map((s) => s.tooth),
    [16, 36],
  );
  assert.equal(suggestions[0].description, "Obturación");
});

test("no sugiere lo que ya está en el plan", () => {
  const suggestions = suggestTreatmentItems(
    [{ tooth: 16, condition: "caries" }],
    [item({ tooth: 16, description: "Obturación", status: "pending" })],
  );
  assert.deepEqual(suggestions, []);
});

test("un ítem cancelado no impide volver a sugerir el trabajo", () => {
  const suggestions = suggestTreatmentItems(
    [{ tooth: 16, condition: "caries" }],
    [item({ tooth: 16, description: "Obturación", status: "cancelled" })],
  );
  assert.equal(suggestions.length, 1);
});

test("no repite la misma sugerencia dos veces", () => {
  const suggestions = suggestTreatmentItems([
    { tooth: 16, condition: "caries" },
    { tooth: 16, condition: "caries" },
  ]);
  assert.equal(suggestions.length, 1);
});
