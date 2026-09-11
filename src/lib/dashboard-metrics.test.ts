import assert from "node:assert/strict";
import test from "node:test";
import {
  formatArs,
  projectedDepositRevenue,
  responseDistribution,
  weeklyAttendance,
  type DashboardMetricsAppointment,
} from "./dashboard-metrics.ts";

const NOW = Date.parse("2026-09-10T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1_000;

function appointment(
  overrides: Partial<DashboardMetricsAppointment> = {},
): DashboardMetricsAppointment {
  return {
    startsAt: new Date(NOW - DAY).toISOString(),
    status: "completed",
    depositStatus: "confirmed",
    depositExpectedAmountArs: 10_000,
    ...overrides,
  };
}

test("la asistencia sólo cuenta turnos cerrados dentro de la ventana", () => {
  const metric = weeklyAttendance(
    [
      appointment({ status: "completed" }),
      appointment({ status: "completed" }),
      appointment({ status: "no_show" }),
      // Cancelado no es una ausencia.
      appointment({ status: "cancelled" }),
      // Todavía agendado: no dice nada sobre asistencia.
      appointment({ status: "scheduled" }),
      // Fuera de la ventana de siete días.
      appointment({
        status: "no_show",
        startsAt: new Date(NOW - 30 * DAY).toISOString(),
      }),
      // En el futuro.
      appointment({
        status: "completed",
        startsAt: new Date(NOW + DAY).toISOString(),
      }),
    ],
    NOW,
  );

  assert.equal(metric.completed, 2);
  assert.equal(metric.noShow, 1);
  assert.equal(metric.rate, 67);
});

test("sin turnos cerrados la asistencia es desconocida, no cero", () => {
  const metric = weeklyAttendance([appointment({ status: "scheduled" })], NOW);
  assert.equal(metric.rate, null, "0 % afirmaría que nadie asistió");
});

test("la seña proyectada separa lo pendiente de lo confirmado", () => {
  const future = new Date(NOW + 2 * DAY).toISOString();
  const metric = projectedDepositRevenue(
    [
      appointment({
        startsAt: future,
        status: "scheduled",
        depositStatus: "pending",
        depositExpectedAmountArs: 10_000,
      }),
      appointment({
        startsAt: future,
        status: "scheduled",
        depositStatus: "proof_received",
        depositExpectedAmountArs: 5_000,
      }),
      appointment({
        startsAt: future,
        status: "confirmed",
        depositStatus: "confirmed",
        depositExpectedAmountArs: 7_000,
      }),
    ],
    NOW,
  );

  assert.equal(metric.pendingArs, 15_000);
  assert.equal(metric.confirmedArs, 7_000);
  assert.equal(metric.totalArs, 22_000);
});

test("la seña proyectada ignora turnos pasados, cancelados y vencidos", () => {
  const future = new Date(NOW + 2 * DAY).toISOString();
  const metric = projectedDepositRevenue(
    [
      appointment({
        startsAt: new Date(NOW - DAY).toISOString(),
        depositStatus: "pending",
      }),
      appointment({
        startsAt: future,
        status: "cancelled",
        depositStatus: "pending",
      }),
      appointment({ startsAt: future, depositStatus: "expired" }),
      appointment({ startsAt: future, depositStatus: "not_required" }),
    ],
    NOW,
  );

  assert.equal(metric.totalArs, 0);
});

test("un turno futuro sin monto se cuenta aparte y no suma cero en silencio", () => {
  const metric = projectedDepositRevenue(
    [
      appointment({
        startsAt: new Date(NOW + DAY).toISOString(),
        status: "scheduled",
        depositStatus: "pending",
        depositExpectedAmountArs: null,
      }),
    ],
    NOW,
  );

  assert.equal(metric.totalArs, 0);
  assert.equal(metric.unknownAmountCount, 1);
});

test("el reparto bot/persona informa el porcentaje automático", () => {
  const metric = responseDistribution({ bot: 3, human: 1 });
  assert.equal(metric.total, 4);
  assert.equal(metric.botShare, 75);
});

test("sin respuestas el reparto es desconocido", () => {
  assert.equal(responseDistribution({ bot: 0, human: 0 }).botShare, null);
});

test("el importe se muestra en pesos sin decimales", () => {
  assert.match(formatArs(22_000), /22\.000/);
});
