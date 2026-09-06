import type { SupabaseClient } from "@supabase/supabase-js";

export type CalendarProjectionState =
  | "synced"
  | "pending"
  | "unavailable"
  | "conflict";

function projectionState(value: unknown): CalendarProjectionState {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return "unavailable";
  const row = value as Record<string, unknown>;
  if (row.state === "synced") {
    return row.projectionStage === "confirmed" ||
      row.projectionStage === "pre_reservation"
      ? "synced"
      : "unavailable";
  }
  return row.state === "pending" || row.state === "conflict"
    ? row.state
    : "unavailable";
}

/** Read-only: opening a turn must not trigger a synchronization. */
export async function readAppointmentCalendar(
  client: SupabaseClient,
  appointmentId: string,
): Promise<CalendarProjectionState> {
  try {
    const { data, error } = await client.rpc(
      "appointment_google_calendar_projection",
      { p_appointment_id: appointmentId },
    );
    return error ? "unavailable" : projectionState(data);
  } catch {
    return "unavailable";
  }
}

/** Called only after the database commit. Failure must never retry creation. */
export async function verifyAppointmentCalendar(
  client: SupabaseClient,
  appointmentId: string,
): Promise<CalendarProjectionState> {
  try {
    const read = () => readAppointmentCalendar(client, appointmentId);
    const initial = await read();
    if (initial !== "pending") return initial;
    try {
      await client.functions.invoke("process-calendar-sync", {
        body: { mode: "manual" },
      });
    } catch {
      // The response may be lost after the exact projection was committed.
    }
    return await read();
  } catch {
    return "unavailable";
  }
}

export function calendarProjectionNotice(
  state: CalendarProjectionState,
): string {
  if (state === "synced")
    return "Turno guardado en el sistema y Google Calendar.";
  return state === "conflict"
    ? "Turno guardado en el sistema. Hay un conflicto con Google Calendar: revisá la agenda antes de confirmarlo al paciente."
    : "Turno guardado en el sistema; falta verificarlo en Google Calendar. Revisá la sincronización antes de confirmarlo al paciente. No vuelvas a crearlo.";
}

export function calendarBookingError(message: string): string {
  if (message.includes("ORTHODONTIC_VISIT_TYPE_REQUIRED"))
    return "Elegí Primera vez o En tratamiento con Gisela para este turno de ortodoncia.";
  if (message.includes("ORTHODONTIC_VISIT_TYPE_NOT_APPLICABLE"))
    return "El tipo de visita sólo corresponde a ortodoncia. Volvé a elegir el servicio.";
  if (
    message.includes("SLOT_UNAVAILABLE") ||
    message.includes("SLOT_NO_LONGER_AVAILABLE")
  ) {
    return "Ese horario acaba de ocuparse. Elegí otro disponible.";
  }
  if (message.includes("CALENDAR")) {
    return "No pudimos comprobar la disponibilidad en Google Calendar. Revisá la conexión y sincronizá la agenda antes de reservar.";
  }
  return "No pudimos comprobar si el turno se guardó. Revisá la agenda antes de volver a intentar.";
}
