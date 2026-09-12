/**
 * Aviso para los turnos de la tarde. Entre las 13 y las 17 el centro está sin
 * atención administrativa y la puerta queda cerrada: el paciente avisa por
 * WhatsApp que llegó y le abren.
 *
 * Compartido por el frontend y las Functions, sin dependencias de sus runtimes.
 * La franja se evalúa en la zona horaria del consultorio, no en la del servidor.
 */

/** Desde las 13 inclusive. */
export const ARRIVAL_NOTICE_START_HOUR = 13;
/** Hasta las 17 exclusive: un turno de las 17 ya tiene atención. */
export const ARRIVAL_NOTICE_END_HOUR = 17;

export const ARRIVAL_NOTICE_MESSAGE =
  "🔔 Entre las 13 y las 17 el centro no tiene atención administrativa y la " +
  "puerta permanece cerrada. Cuando llegues, enviá un mensaje al 2291-414102 " +
  "avisando que estás en la puerta.";

const MAX_MESSAGE_LENGTH = 4096;

/** Hora local del turno, o null si la fecha o la zona no se pueden leer. */
export function appointmentHourInTimeZone(
  startsAt: string,
  timeZone: string,
): number | null {
  const date = new Date(startsAt);
  if (!Number.isFinite(date.getTime())) return null;
  try {
    const hour = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      hour12: false,
    }).format(date);
    const parsed = Number.parseInt(hour, 10);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 24) return null;
    // Algunos runtimes escriben la medianoche como 24.
    return parsed === 24 ? 0 : parsed;
  } catch {
    return null;
  }
}

export function needsArrivalNotice(
  startsAt: string,
  timeZone: string,
): boolean {
  const hour = appointmentHourInTimeZone(startsAt, timeZone);
  if (hour === null) return false;
  return hour >= ARRIVAL_NOTICE_START_HOUR && hour < ARRIVAL_NOTICE_END_HOUR;
}

/**
 * Suma el aviso a un mensaje ya armado. No lo repite si ya está, y si no
 * entraría en un mensaje de WhatsApp devuelve el original sin tocar.
 */
export function appendArrivalNotice(
  message: string,
  startsAt: string,
  timeZone: string,
): string {
  if (!message.trim() || !needsArrivalNotice(startsAt, timeZone))
    return message;
  if (message.includes(ARRIVAL_NOTICE_MESSAGE)) return message;
  const combined = `${message.trimEnd()}\n\n${ARRIVAL_NOTICE_MESSAGE}`;
  return combined.length <= MAX_MESSAGE_LENGTH ? combined : message;
}
