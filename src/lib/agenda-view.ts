/**
 * Rangos y grillas de la agenda para las vistas de día, semana y mes.
 *
 * Este módulo trabaja sólo con fechas calendario (`YYYY-MM-DD`) y no conoce la
 * zona horaria: quien consulta traduce el rango a instantes con
 * `getBusinessCalendarDayRange`, que ya resuelve la zona del consultorio. Esa
 * separación mantiene la aritmética de calendario probable sin arrastrar la
 * configuración del negocio.
 *
 * El mediodía UTC como ancla es la misma convención que ya usaba la agenda:
 * sumar días desde ahí nunca cruza un cambio de horario.
 */

export type AgendaViewMode = "day" | "week" | "month";

export function isAgendaViewMode(value: unknown): value is AgendaViewMode {
  return value === "day" || value === "week" || value === "month";
}

function anchor(value: string): Date {
  return new Date(`${value}T12:00:00Z`);
}

function toCalendarDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function shiftCalendarDate(value: string, days: number): string {
  const date = anchor(value);
  date.setUTCDate(date.getUTCDate() + days);
  return toCalendarDate(date);
}

/** La semana del consultorio arranca el lunes. */
export function startOfWeek(value: string): string {
  const weekday = anchor(value).getUTCDay();
  return shiftCalendarDate(value, -((weekday + 6) % 7));
}

export function startOfMonth(value: string): string {
  return `${value.slice(0, 7)}-01`;
}

export function weekDays(value: string): string[] {
  const start = startOfWeek(value);
  return Array.from({ length: 7 }, (_, index) =>
    shiftCalendarDate(start, index),
  );
}

/**
 * Seis semanas completas: siempre la misma altura, para que cambiar de mes no
 * mueva el resto de la pantalla. Los días de relleno se marcan como ajenos al
 * mes para poder atenuarlos.
 */
export interface MonthGridDay {
  date: string;
  inMonth: boolean;
}

export function monthGrid(value: string): MonthGridDay[] {
  const first = startOfMonth(value);
  const month = first.slice(0, 7);
  const start = startOfWeek(first);
  return Array.from({ length: 42 }, (_, index) => {
    const date = shiftCalendarDate(start, index);
    return { date, inMonth: date.slice(0, 7) === month };
  });
}

/** Primer y último día visible, inclusive, para la vista pedida. */
export function agendaVisibleDates(
  mode: AgendaViewMode,
  value: string,
): { from: string; to: string } {
  if (mode === "day") return { from: value, to: value };
  if (mode === "week") {
    const days = weekDays(value);
    return { from: days[0], to: days[days.length - 1] };
  }
  const grid = monthGrid(value);
  return { from: grid[0].date, to: grid[grid.length - 1].date };
}

/** Cuánto avanza o retrocede la navegación según la vista. */
export function shiftAgendaDate(
  mode: AgendaViewMode,
  value: string,
  direction: 1 | -1,
): string {
  if (mode === "day") return shiftCalendarDate(value, direction);
  if (mode === "week") return shiftCalendarDate(value, 7 * direction);
  const date = anchor(startOfMonth(value));
  date.setUTCMonth(date.getUTCMonth() + direction);
  return toCalendarDate(date);
}
