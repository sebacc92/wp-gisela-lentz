export type ReminderType = "appointment_24h" | "appointment_2h";

export function isReminderEligibleAppointment(
  status: string,
  startsAt: string,
  now = new Date(),
): boolean {
  const startsAtMs = new Date(startsAt).getTime();
  return (
    status === "confirmed" &&
    Number.isFinite(startsAtMs) &&
    startsAtMs > now.getTime()
  );
}

export function isExpiredHoldNotificationEligible(value: {
  status: string;
  depositStatus: string;
  depositProofLate: boolean;
  notificationStatus: string;
}): boolean {
  return (
    value.status === "cancelled" &&
    value.depositStatus === "expired" &&
    value.depositProofLate === false &&
    value.notificationStatus === "processing"
  );
}

interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

function calendarDateAt(value: Date, timezone: string): CalendarDate | null {
  if (Number.isNaN(value.getTime()) || !timezone.trim()) return null;

  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(value);
    const values = Object.fromEntries(
      parts
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, Number(part.value)]),
    );
    if (
      !Number.isInteger(values.year) ||
      !Number.isInteger(values.month) ||
      !Number.isInteger(values.day)
    ) {
      return null;
    }
    return {
      year: values.year,
      month: values.month,
      day: values.day,
    };
  } catch {
    return null;
  }
}

function nextCalendarDate(value: CalendarDate): CalendarDate {
  const next = new Date(Date.UTC(value.year, value.month - 1, value.day + 1));
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
  };
}

/**
 * Revalidación defensiva inmediatamente antes del envío. La base de datos hace
 * el mismo control al reclamar, pero esta barrera evita un envío tardío si el
 * worker atraviesa la medianoche local mientras procesa el lote.
 */
export function isAppointmentTomorrow(
  startsAt: string,
  now: Date,
  timezone: string,
): boolean {
  const appointmentDate = calendarDateAt(new Date(startsAt), timezone);
  const today = calendarDateAt(now, timezone);
  if (!appointmentDate || !today) return false;

  const tomorrow = nextCalendarDate(today);
  return (
    appointmentDate.year === tomorrow.year &&
    appointmentDate.month === tomorrow.month &&
    appointmentDate.day === tomorrow.day
  );
}

export function reminderTemplateKey(type: ReminderType): string {
  return type === "appointment_24h"
    ? "appointment_reminder_24h"
    : "appointment_reminder_2h";
}
