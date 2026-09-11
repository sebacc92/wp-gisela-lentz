import assert from "node:assert/strict";
import test from "node:test";
import {
  agendaVisibleDates,
  isAgendaViewMode,
  monthGrid,
  shiftAgendaDate,
  shiftCalendarDate,
  startOfMonth,
  startOfWeek,
  weekDays,
} from "./agenda-view.ts";

test("la semana arranca el lunes", () => {
  // 2026-09-10 es jueves.
  assert.equal(startOfWeek("2026-09-10"), "2026-09-07");
  // Un lunes se queda donde está.
  assert.equal(startOfWeek("2026-09-07"), "2026-09-07");
  // Un domingo pertenece a la semana que empezó el lunes anterior.
  assert.equal(startOfWeek("2026-09-13"), "2026-09-07");
});

test("la semana tiene siete días consecutivos", () => {
  assert.deepEqual(weekDays("2026-09-10"), [
    "2026-09-07",
    "2026-09-08",
    "2026-09-09",
    "2026-09-10",
    "2026-09-11",
    "2026-09-12",
    "2026-09-13",
  ]);
});

test("la grilla del mes son seis semanas completas", () => {
  const grid = monthGrid("2026-09-10");
  assert.equal(grid.length, 42);
  assert.equal(grid[0].date, startOfWeek("2026-09-01"));
  assert.ok(
    grid.every(
      (day, index) =>
        index === 0 || day.date === shiftCalendarDate(grid[index - 1].date, 1),
    ),
    "los días de la grilla son consecutivos",
  );
});

test("la grilla distingue los días de relleno", () => {
  const grid = monthGrid("2026-09-10");
  const septiembre = grid.filter((day) => day.inMonth);
  assert.equal(septiembre.length, 30);
  assert.ok(septiembre.every((day) => day.date.startsWith("2026-09")));
});

test("un mes que arranca lunes no deja relleno adelante", () => {
  // 2026-06-01 es lunes.
  const grid = monthGrid("2026-06-15");
  assert.equal(grid[0].date, "2026-06-01");
  assert.equal(grid[0].inMonth, true);
});

test("el rango visible cubre lo que se muestra", () => {
  assert.deepEqual(agendaVisibleDates("day", "2026-09-10"), {
    from: "2026-09-10",
    to: "2026-09-10",
  });
  assert.deepEqual(agendaVisibleDates("week", "2026-09-10"), {
    from: "2026-09-07",
    to: "2026-09-13",
  });
  const month = agendaVisibleDates("month", "2026-09-10");
  assert.equal(month.from, "2026-08-31");
  assert.equal(month.to, shiftCalendarDate(month.from, 41));
});

test("la navegación avanza según la vista", () => {
  assert.equal(shiftAgendaDate("day", "2026-09-10", 1), "2026-09-11");
  assert.equal(shiftAgendaDate("week", "2026-09-10", -1), "2026-09-03");
  assert.equal(shiftAgendaDate("month", "2026-09-10", 1), "2026-10-01");
  assert.equal(shiftAgendaDate("month", "2026-01-31", -1), "2025-12-01");
});

test("cruzar fin de año no rompe la aritmética", () => {
  assert.equal(shiftCalendarDate("2026-12-31", 1), "2027-01-01");
  assert.equal(startOfMonth("2026-12-31"), "2026-12-01");
});

test("sólo se aceptan los tres modos conocidos", () => {
  assert.equal(isAgendaViewMode("month"), true);
  assert.equal(isAgendaViewMode("year"), false);
  assert.equal(isAgendaViewMode(null), false);
});
