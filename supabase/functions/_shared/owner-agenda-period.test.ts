import assert from "node:assert/strict";
import test from "node:test";
import { detectOwnerRequest, ownerAgendaRange } from "./owner-access.ts";

const MONDAY = new Date("2026-09-07T19:20:45Z");

test("los pedidos reales de Seba conservan jueves y próximos en lugar de consultar hoy", () => {
  assert.deepEqual(detectOwnerRequest("Dame los turnos del jueves", MONDAY), {
    kind: "agenda",
    day: { date: "2026-09-10" },
  });
  assert.deepEqual(
    detectOwnerRequest("Dame los próximos turnos todos", MONDAY),
    {
      kind: "agenda",
      day: "upcoming",
    },
  );
  assert.deepEqual(ownerAgendaRange("upcoming", MONDAY), {
    from: MONDAY.toISOString(),
    until: null,
    localDate: "2026-09-07",
  });
});

test("los días de semana se calculan en Argentina y avanzan al siguiente encuentro", () => {
  const fridayNight = new Date("2026-09-12T01:00:00Z");
  for (const [body, date] of [
    ["turnos del viernes", "2026-09-11"],
    ["turnos del próximo viernes", "2026-09-18"],
    ["turnos del lunes", "2026-09-14"],
    ["turnos del jueves de la semana que viene", "2026-09-17"],
    ["turnos de pasado mañana", "2026-09-13"],
  ]) {
    assert.deepEqual(
      detectOwnerRequest(body, fridayNight),
      { kind: "agenda", day: { date } },
      body,
    );
  }
  assert.deepEqual(
    detectOwnerRequest("turnos del viernes", new Date("2026-12-31T20:00:00Z")),
    {
      kind: "agenda",
      day: { date: "2027-01-01" },
    },
  );
});

test("fechas explícitas y próxima semana usan límites de calendario completos", () => {
  for (const body of [
    "turnos del 10/9",
    "turnos del 10/9/2026",
    "turnos del jueves 10/9",
    "turnos del 2026-09-10",
  ]) {
    const request = detectOwnerRequest(body, MONDAY);
    assert.deepEqual(request, { kind: "agenda", day: { date: "2026-09-10" } });
    assert.equal(
      ownerAgendaRange({ date: "2026-09-10" }, MONDAY).until,
      "2026-09-11T03:00:00.000Z",
    );
  }
  assert.deepEqual(
    detectOwnerRequest("turnos de la semana que viene", MONDAY),
    {
      kind: "agenda",
      day: { date: "2026-09-14", days: 7 },
    },
  );
});

test("fechas inválidas, ambiguas o no soportadas piden aclaración sin devolver hoy", () => {
  for (const body of [
    "turnos del 31/2",
    "turnos del 10/9/26",
    "turnos del martes 10/9",
    "turnos de navidad",
    "turnos del mes que viene",
    "turnos del jueves pasado",
    "turnos de la semana pasada",
    "turnos de hoy y mañana",
    "turnos del jueves y viernes",
    "turnos del 10/9 al 12/9",
    "turnos dentro de 3 días",
    "Tengo una duda",
  ])
    assert.equal(detectOwnerRequest(body, MONDAY), null, body);
});
