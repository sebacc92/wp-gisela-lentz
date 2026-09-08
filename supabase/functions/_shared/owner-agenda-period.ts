import { normalizeUserInput } from "./automation-flow.ts";

export const OWNER_TIMEZONE = "America/Argentina/Buenos_Aires";

export type OwnerAgendaDay =
  | "today"
  | "tomorrow"
  | "week"
  | "upcoming"
  | { date: string; days?: 7 };

export function ownerLocalDate(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: OWNER_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function addDays(date: string, days: number): string {
  const shifted = new Date(`${date}T12:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

/** A date the parser cannot interpret must never silently become today's agenda. */
export function parseOwnerAgendaDay(
  body: string,
  now = new Date(),
): OwnerAgendaDay | null {
  const phrase = normalizeUserInput(body);
  if (
    /\b(ayer|anteayer|pasada|pasadas|pasados|anterior|mes|meses|dentro|entre|desde|hasta)\b/.test(
      phrase,
    ) ||
    /\bpasado\b(?! manana\b)/.test(phrase)
  )
    return null;
  const today = ownerLocalDate(now);
  const currentWeekday = new Date(`${today}T12:00:00Z`).getUTCDay();
  const weekdays = [
    "domingo",
    "lunes",
    "martes",
    "miercoles",
    "jueves",
    "viernes",
    "sabado",
  ];
  const mentionedDays =
    phrase.match(
      /\b(domingo|lunes|martes|miercoles|jueves|viernes|sabado)\b/g,
    ) ?? [];
  const numericDates =
    body.match(/\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}(?:\/\d{4})?)\b/g) ?? [];
  if (mentionedDays.length > 1 || numericDates.length > 1) return null;
  const mentionedDay = mentionedDays[0];
  const input = numericDates[0];
  const relativeDays = phrase.match(/\b(hoy|manana)\b/g) ?? [];
  if (
    relativeDays.length > 1 ||
    (relativeDays.length && (input || mentionedDay))
  )
    return null;
  if (input) {
    if (/\d/.test(body.replace(input, ""))) return null;
    const parts = input.split("/");
    const date =
      parts.length > 1
        ? `${parts[2] ?? today.slice(0, 4)}-${parts[1].padStart(2, "0")}-${parts[0].padStart(2, "0")}`
        : input;
    const parsed = new Date(`${date}T12:00:00Z`);
    if (
      !Number.isFinite(parsed.getTime()) ||
      parsed.toISOString().slice(0, 10) !== date
    )
      return null;
    if (mentionedDay && weekdays[parsed.getUTCDay()] !== mentionedDay)
      return null;
    return { date };
  }
  if (/\d/.test(phrase)) return null;
  if (mentionedDay) {
    let offset = (weekdays.indexOf(mentionedDay) - currentWeekday + 7) % 7;
    if (/\b(semana que viene|semana proxima|proxima semana)\b/.test(phrase)) {
      offset = (8 - currentWeekday) % 7 || 7;
      offset += (weekdays.indexOf(mentionedDay) + 6) % 7;
    } else if (offset === 0 && /\b(proximo|que viene)\b/.test(phrase)) {
      offset = 7;
    }
    return { date: addDays(today, offset) };
  }
  if (/\b(semana que viene|semana proxima|proxima semana)\b/.test(phrase)) {
    return { date: addDays(today, (8 - currentWeekday) % 7 || 7), days: 7 };
  }
  if (/\b(pasado manana)\b/.test(phrase)) return { date: addDays(today, 2) };
  if (/\bmanana\b/.test(phrase)) return "tomorrow";
  if (/\bsemana\b/.test(phrase)) return "week";
  if (/\bhoy\b/.test(phrase)) return "today";
  if (/\b(proximo|proximos|siguientes|futuros|todos)\b/.test(phrase))
    return "upcoming";
  if (/\b(del|el|para|de|pasado|proximo|proxima)\b/.test(phrase)) return null;
  return "today";
}
