import type { SupabaseClient } from "@supabase/supabase-js";

export type BlockConversionError =
  | "ADMIN_REQUIRED"
  | "CALENDAR_NOT_CONNECTED"
  | "CALENDAR_BLOCK_NOT_FOUND"
  | "CALENDAR_BLOCK_NOT_ACTIVE"
  | "SLOT_UNAVAILABLE"
  | "COVERAGE_REQUIRED"
  | "SERVICE_NOT_AVAILABLE"
  | "UNKNOWN";

export interface BlockConversionResult {
  appointmentId: string | null;
  created: boolean;
  error: BlockConversionError | null;
}

export function blockConversionError(message: unknown): BlockConversionError {
  const text = typeof message === "string" ? message : "";
  if (text.includes("ADMIN_REQUIRED")) return "ADMIN_REQUIRED";
  if (text.includes("CALENDAR_NOT_CONNECTED")) return "CALENDAR_NOT_CONNECTED";
  if (text.includes("CALENDAR_BLOCK_NOT_FOUND")) {
    return "CALENDAR_BLOCK_NOT_FOUND";
  }
  if (text.includes("CALENDAR_BLOCK_NOT_ACTIVE")) {
    return "CALENDAR_BLOCK_NOT_ACTIVE";
  }
  if (text.includes("SLOT_UNAVAILABLE")) return "SLOT_UNAVAILABLE";
  if (text.includes("COVERAGE_REQUIRED")) return "COVERAGE_REQUIRED";
  if (text.includes("SERVICE_NOT_AVAILABLE")) return "SERVICE_NOT_AVAILABLE";
  return "UNKNOWN";
}

export function describeBlockConversionError(
  error: BlockConversionError,
): string {
  switch (error) {
    case "ADMIN_REQUIRED":
      return "Convertir un bloqueo en turno lo hace la persona administradora.";
    case "CALENDAR_NOT_CONNECTED":
      return "Google Calendar no está conectado. El bloqueo quedó como estaba.";
    case "CALENDAR_BLOCK_NOT_FOUND":
    case "CALENDAR_BLOCK_NOT_ACTIVE":
      return "Ese bloqueo ya no está disponible. Actualizá la agenda para ver su estado.";
    case "SLOT_UNAVAILABLE":
      return "Ese horario ya no está libre. El bloqueo se mantiene sin cambios.";
    case "COVERAGE_REQUIRED":
      return "Falta la cobertura del paciente. Cargala en su ficha y volvé a intentar.";
    case "SERVICE_NOT_AVAILABLE":
      return "Ese servicio no está activo. El bloqueo se mantiene sin cambios.";
    default:
      return "No pudimos convertir el bloqueo. No se hicieron cambios; intentá de nuevo.";
  }
}

/**
 * Única vía de conversión: el RPC retira el bloqueo y crea el turno con las
 * validaciones normales dentro de la misma transacción. Acá no se crea ningún
 * turno por separado, así no existe una segunda implementación de reserva.
 */
export async function convertCalendarBlock(
  client: SupabaseClient,
  input: {
    googleEventId: string;
    contactId: string;
    professionalId: string;
    serviceId: string;
    startsAt?: string | null;
    internalNote?: string | null;
  },
): Promise<BlockConversionResult> {
  const { data, error } = await client.rpc(
    "convert_google_calendar_block_to_appointment",
    {
      p_google_event_id: input.googleEventId,
      p_contact_id: input.contactId,
      p_professional_id: input.professionalId,
      p_service_id: input.serviceId,
      p_starts_at: input.startsAt ?? null,
      p_internal_note: input.internalNote?.trim() || null,
    },
  );
  if (error) {
    return {
      appointmentId: null,
      created: false,
      error: blockConversionError(error.message),
    };
  }
  const row = (Array.isArray(data) ? data[0] : data) as {
    appointment_id?: string;
    created?: boolean;
  } | null;
  return {
    appointmentId: row?.appointment_id ?? null,
    created: row?.created === true,
    error: null,
  };
}
