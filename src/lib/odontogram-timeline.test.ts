import assert from "node:assert/strict";
import test from "node:test";
import {
  changesBetween,
  snapshotAt,
  timelinePoints,
} from "./odontogram-timeline.ts";
import type { OdontogramEntry } from "./odontogram.ts";

function entry(
  sequence: number,
  tooth: number,
  condition: OdontogramEntry["condition"],
  day: string,
): OdontogramEntry {
  return {
    id: `e${sequence}`,
    contactId: "c1",
    tooth,
    condition,
    surfaces: {},
    note: null,
    recordedAt: `${day}T12:00:00.000Z`,
    entrySequence: sequence,
  };
}

const ENTRIES: OdontogramEntry[] = [
  entry(1, 16, "caries", "2026-03-01"),
  entry(2, 21, "caries", "2026-03-01"),
  entry(3, 16, "obturado", "2026-06-15"),
  entry(4, 36, "extraccion_indicada", "2026-09-01"),
];

test("agrupa la línea de tiempo por día con actividad", () => {
  const points = timelinePoints(ENTRIES);
  assert.deepEqual(
    points.map((point) => point.recordedAt.slice(0, 10)),
    ["2026-03-01", "2026-06-15", "2026-09-01"],
  );
  assert.equal(points[0].entryCount, 2, "los dos asientos del mismo día");
});

test("la parada de un día refleja cómo quedó al terminarlo", () => {
  const [first] = timelinePoints(ENTRIES);
  assert.equal(first.sequence, 2);
});

test("el estado en una parada usa sólo los asientos hasta ahí", () => {
  const marzo = snapshotAt(ENTRIES, 2);
  assert.equal(marzo.get(16)?.condition, "caries");
  assert.equal(marzo.get(36), undefined, "todavía no existía ese asiento");

  const junio = snapshotAt(ENTRIES, 3);
  assert.equal(junio.get(16)?.condition, "obturado");
});

test("comparar dos paradas muestra sólo lo que cambió", () => {
  const changes = changesBetween(ENTRIES, 2, 4);
  assert.deepEqual(
    changes.map((change) => change.tooth),
    [16, 36],
    "la pieza 21 no cambió entre esas paradas",
  );
  assert.equal(changes[0].before?.condition, "caries");
  assert.equal(changes[0].after?.condition, "obturado");
});

test("una pieza registrada por primera vez aparece como cambio sin estado previo", () => {
  const [change] = changesBetween(ENTRIES, 3, 4);
  assert.equal(change.tooth, 36);
  assert.equal(change.before, undefined);
  assert.equal(change.after?.condition, "extraccion_indicada");
});

test("comparar una parada consigo misma no muestra cambios", () => {
  assert.deepEqual(changesBetween(ENTRIES, 3, 3), []);
});

test("una ficha vacía no tiene paradas", () => {
  assert.deepEqual(timelinePoints([]), []);
});
