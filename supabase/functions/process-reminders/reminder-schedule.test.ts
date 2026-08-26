import assert from "node:assert/strict";
import test from "node:test";

import {
  isAppointmentTomorrow,
  isExpiredHoldNotificationEligible,
  isReminderEligibleAppointment,
  reminderTemplateKey,
} from "./reminder-schedule.ts";

const TIMEZONE = "America/Argentina/Buenos_Aires";

test("reconoce mañana según el calendario de Buenos Aires", () => {
  const beforeQueue = new Date("2026-08-13T00:00:00.000Z"); // 12/08 21:00

  assert.equal(
    isAppointmentTomorrow(
      "2026-08-13T12:30:00.000Z", // 13/08 09:30
      beforeQueue,
      TIMEZONE,
    ),
    true,
  );
  assert.equal(
    isAppointmentTomorrow("2026-08-14T12:30:00.000Z", beforeQueue, TIMEZONE),
    false,
  );
});

test("deja de considerar mañana al cruzar la medianoche local", () => {
  const beforeMidnight = new Date("2026-08-13T02:59:59.000Z");
  const afterMidnight = new Date("2026-08-13T03:00:00.000Z");
  const appointment = "2026-08-13T12:30:00.000Z";

  assert.equal(
    isAppointmentTomorrow(appointment, beforeMidnight, TIMEZONE),
    true,
  );
  assert.equal(
    isAppointmentTomorrow(appointment, afterMidnight, TIMEZONE),
    false,
  );
});

test("falla cerrado ante fecha o zona horaria inválida", () => {
  assert.equal(
    isAppointmentTomorrow("no-es-fecha", new Date(), TIMEZONE),
    false,
  );
  assert.equal(
    isAppointmentTomorrow(
      "2026-08-13T12:30:00.000Z",
      new Date("2026-08-13T00:00:00.000Z"),
      "Zona/Inexistente",
    ),
    false,
  );
});

test("reutiliza las plantillas Meta existentes", () => {
  assert.equal(
    reminderTemplateKey("appointment_24h"),
    "appointment_reminder_24h",
  );
  assert.equal(
    reminderTemplateKey("appointment_2h"),
    "appointment_reminder_2h",
  );
});

test("sólo un turno confirmado y futuro puede recibir recordatorios", () => {
  const now = new Date("2026-08-12T12:00:00.000Z");
  const future = "2026-08-13T12:00:00.000Z";
  assert.equal(isReminderEligibleAppointment("confirmed", future, now), true);
  assert.equal(isReminderEligibleAppointment("scheduled", future, now), false);
  assert.equal(isReminderEligibleAppointment("cancelled", future, now), false);
  assert.equal(
    isReminderEligibleAppointment("confirmed", "2026-08-12T11:59:59.000Z", now),
    false,
  );
});

test("el aviso de reserva vencida se cancela si llegó un comprobante tardío", () => {
  const eligible = {
    status: "cancelled",
    depositStatus: "expired",
    depositProofLate: false,
    notificationStatus: "processing",
  };
  assert.equal(isExpiredHoldNotificationEligible(eligible), true);
  assert.equal(
    isExpiredHoldNotificationEligible({
      ...eligible,
      depositProofLate: true,
    }),
    false,
  );
  assert.equal(
    isExpiredHoldNotificationEligible({
      ...eligible,
      notificationStatus: "cancelled",
    }),
    false,
  );
});
