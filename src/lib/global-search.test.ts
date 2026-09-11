import assert from "node:assert/strict";
import test from "node:test";
import {
  appointmentHref,
  compareAppointments,
  conversationHref,
  groupResults,
  patientHref,
  type GlobalSearchResult,
} from "./global-search.ts";

const NOW = Date.parse("2026-09-10T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function result(
  overrides: Partial<GlobalSearchResult> = {},
): GlobalSearchResult {
  return {
    kind: "patient",
    id: "1",
    title: "Ana",
    subtitle: "",
    href: "/app",
    ...overrides,
  };
}

test("los enlaces escapan el identificador", () => {
  assert.equal(patientHref("a b&c"), "/app/patients?patient=a%20b%26c");
  assert.equal(conversationHref("x/y"), "/app/inbox?conversation=x%2Fy");
});

test("el turno enlaza al día en que ocurre", () => {
  const href = appointmentHref("abc", "2026-09-11");
  assert.match(href, /date=2026-09-11/);
  assert.match(href, /appointment=abc/);
});

test("los turnos futuros van antes que los pasados", () => {
  const future = result({ startsAt: new Date(NOW + DAY).toISOString() });
  const past = result({ startsAt: new Date(NOW - DAY).toISOString() });
  assert.ok(compareAppointments(future, past, NOW) < 0);
  assert.ok(compareAppointments(past, future, NOW) > 0);
});

test("entre futuros gana el más cercano", () => {
  const soon = result({ startsAt: new Date(NOW + DAY).toISOString() });
  const later = result({ startsAt: new Date(NOW + 5 * DAY).toISOString() });
  assert.ok(compareAppointments(soon, later, NOW) < 0);
});

test("entre pasados gana el más reciente", () => {
  const recent = result({ startsAt: new Date(NOW - DAY).toISOString() });
  const old = result({ startsAt: new Date(NOW - 30 * DAY).toISOString() });
  assert.ok(compareAppointments(recent, old, NOW) < 0);
});

test("un turno sin fecha queda al final", () => {
  const dated = result({ startsAt: new Date(NOW).toISOString() });
  assert.ok(compareAppointments(result(), dated, NOW) > 0);
});

test("los grupos vacíos no se muestran", () => {
  const groups = groupResults([
    result({ kind: "patient" }),
    result({ kind: "conversation", id: "2" }),
  ]);
  assert.deepEqual(
    groups.map((group) => group.kind),
    ["patient", "conversation"],
    "sin turnos, el grupo de turnos no aparece",
  );
});

test("el orden de los grupos es estable: paciente, turno, conversación", () => {
  const groups = groupResults([
    result({ kind: "conversation", id: "c" }),
    result({ kind: "appointment", id: "a" }),
    result({ kind: "patient", id: "p" }),
  ]);
  assert.deepEqual(
    groups.map((group) => group.kind),
    ["patient", "appointment", "conversation"],
  );
});
