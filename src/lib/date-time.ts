import { BUSINESS_CONFIG } from "~/config/business";

interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

function dateTimeParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);

  return Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  ) as Record<"year" | "month" | "day" | "hour" | "minute" | "second", number>;
}

function timeZoneOffset(date: Date, timeZone: string): number {
  const parts = dateTimeParts(date, timeZone);
  const representedAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return representedAsUtc - Math.floor(date.getTime() / 1_000) * 1_000;
}

function calendarDateAfter(date: CalendarDate, days: number): CalendarDate {
  const shifted = new Date(
    Date.UTC(date.year, date.month - 1, date.day + days),
  );
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function zonedMidnight(date: CalendarDate, timeZone: string): Date {
  const utcGuess = Date.UTC(date.year, date.month - 1, date.day);
  let result = utcGuess - timeZoneOffset(new Date(utcGuess), timeZone);

  // A second pass also handles timezones whose offset changes near this date.
  result = utcGuess - timeZoneOffset(new Date(result), timeZone);
  return new Date(result);
}

export function businessDateInput(
  reference = new Date(),
  timeZone = BUSINESS_CONFIG.timezone,
): string {
  const current = dateTimeParts(reference, timeZone);
  return `${String(current.year).padStart(4, "0")}-${String(current.month).padStart(2, "0")}-${String(current.day).padStart(2, "0")}`;
}

export function getBusinessCalendarDayRange(
  value: string,
  timeZone = BUSINESS_CONFIG.timezone,
): { from: Date; to: Date } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error("INVALID_CALENDAR_DATE");
  const calendarDate = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
  const normalized = new Date(
    Date.UTC(calendarDate.year, calendarDate.month - 1, calendarDate.day),
  );
  if (
    normalized.getUTCFullYear() !== calendarDate.year ||
    normalized.getUTCMonth() + 1 !== calendarDate.month ||
    normalized.getUTCDate() !== calendarDate.day
  ) {
    throw new Error("INVALID_CALENDAR_DATE");
  }
  return {
    from: zonedMidnight(calendarDate, timeZone),
    to: zonedMidnight(calendarDateAfter(calendarDate, 1), timeZone),
  };
}

export function getBusinessDayRange(
  reference = new Date(),
  days = 1,
  timeZone = BUSINESS_CONFIG.timezone,
): { from: Date; to: Date } {
  const current = dateTimeParts(reference, timeZone);
  const calendarDate = {
    year: current.year,
    month: current.month,
    day: current.day,
  };

  return {
    from: zonedMidnight(calendarDate, timeZone),
    to: zonedMidnight(calendarDateAfter(calendarDate, days), timeZone),
  };
}

export function formatBusinessDate(
  date: Date,
  options: Intl.DateTimeFormatOptions,
  timeZone = BUSINESS_CONFIG.timezone,
): string {
  return new Intl.DateTimeFormat("es-AR", { ...options, timeZone }).format(
    date,
  );
}
