import type { OrthodonticVisitType, PatientCoverage } from "./inbox-types";
import type { SupabaseClient } from "@supabase/supabase-js";

export type BlockConversionError =
  | "ADMIN_REQUIRED"
  | "CALENDAR_NOT_CONNECTED"
  | "CALENDAR_NOT_READY"
  | "GOOGLE_CALENDAR_IMPORT_SCOPE_STALE"
  | "CALENDAR_BLOCK_NOT_FOUND"
  | "CALENDAR_BLOCK_NOT_ACTIVE"
  | "CALENDAR_BLOCK_STALE"
  | "CALENDAR_BLOCK_UNSUPPORTED"
  | "CALENDAR_BLOCK_DURATION_INVALID"
  | "CALENDAR_BLOCK_IN_PAST"
  | "CALENDAR_BLOCK_CONVERSION_CONFLICT"
  | "SLOT_UNAVAILABLE"
  | "COVERAGE_REQUIRED"
  | "PATIENT_NAME_REQUIRED"
  | "PATIENT_NAME_INVALID"
  | "CALENDAR_PATIENT_DETAILS_REQUIRED"
  | "PATIENT_PHONE_REQUIRED"
  | "PATIENT_PHONE_INVALID"
  | "CONTACT_NOT_FOUND"
  | "CONTACT_IDENTITY_CONFLICT"
  | "PROFESSIONAL_NOT_AVAILABLE"
  | "SERVICE_NOT_AVAILABLE"
  | "ORTHODONTIC_VISIT_TYPE_REQUIRED"
  | "ORTHODONTIC_VISIT_TYPE_NOT_APPLICABLE"
  | "UNKNOWN";

export interface BlockConversionResult {
  appointmentId: string | null;
  created: boolean;
  error: BlockConversionError | null;
}

export function blockConversionError(message: unknown): BlockConversionError {
  const text = typeof message === "string" ? message : "";
  if (text.includes("ORTHODONTIC_VISIT_TYPE_REQUIRED"))
    return "ORTHODONTIC_VISIT_TYPE_REQUIRED";
  if (text.includes("ORTHODONTIC_VISIT_TYPE_NOT_APPLICABLE"))
    return "ORTHODONTIC_VISIT_TYPE_NOT_APPLICABLE";
  if (text.includes("ADMIN_REQUIRED")) return "ADMIN_REQUIRED";
  if (text.includes("CALENDAR_NOT_CONNECTED")) return "CALENDAR_NOT_CONNECTED";
  for (const code of [
    "CALENDAR_NOT_READY",
    "GOOGLE_CALENDAR_IMPORT_SCOPE_STALE",
    "CALENDAR_BLOCK_UNSUPPORTED",
    "CALENDAR_BLOCK_DURATION_INVALID",
    "CALENDAR_BLOCK_IN_PAST",
    "CALENDAR_BLOCK_CONVERSION_CONFLICT",
    "PATIENT_NAME_INVALID",
    "CALENDAR_PATIENT_DETAILS_REQUIRED",
    "CONTACT_IDENTITY_CONFLICT",
    "PROFESSIONAL_NOT_AVAILABLE",
  ] as const) {
    if (text.includes(code)) return code;
  }
  if (text.includes("CALENDAR_BLOCK_NOT_FOUND")) {
    return "CALENDAR_BLOCK_NOT_FOUND";
  }
  if (text.includes("CALENDAR_BLOCK_NOT_ACTIVE")) {
    return "CALENDAR_BLOCK_NOT_ACTIVE";
  }
  if (text.includes("CALENDAR_BLOCK_STALE")) return "CALENDAR_BLOCK_STALE";
  if (text.includes("SLOT_UNAVAILABLE")) return "SLOT_UNAVAILABLE";
  if (text.includes("COVERAGE_REQUIRED")) return "COVERAGE_REQUIRED";
  if (text.includes("PATIENT_NAME_REQUIRED")) return "PATIENT_NAME_REQUIRED";
  if (text.includes("PATIENT_PHONE_REQUIRED")) return "PATIENT_PHONE_REQUIRED";
  if (text.includes("PATIENT_PHONE_INVALID")) return "PATIENT_PHONE_INVALID";
  if (text.includes("CONTACT_NOT_FOUND")) return "CONTACT_NOT_FOUND";
  if (text.includes("SERVICE_NOT_AVAILABLE")) return "SERVICE_NOT_AVAILABLE";
  return "UNKNOWN";
}

export function describeBlockConversionError(
  error: BlockConversionError,
): string {
  switch (error) {
    case "ORTHODONTIC_VISIT_TYPE_REQUIRED":
      return "Elegí Primera vez o En tratamiento con Gisela para este turno de ortodoncia.";
    case "ORTHODONTIC_VISIT_TYPE_NOT_APPLICABLE":
      return "El tipo de visita sólo corresponde a ortodoncia. Volvé a elegir el servicio.";
    case "ADMIN_REQUIRED":
      return "Convertir un bloqueo en turno lo hace la persona administradora.";
    case "CALENDAR_NOT_CONNECTED":
      return "Google Calendar no está conectado. El bloqueo quedó como estaba.";
    case "CALENDAR_NOT_READY":
    case "GOOGLE_CALENDAR_IMPORT_SCOPE_STALE":
      return "Falta actualizar la sincronización de Google Calendar. Sincronizá la agenda y volvé a abrir el evento.";
    case "CALENDAR_BLOCK_NOT_FOUND":
    case "CALENDAR_BLOCK_NOT_ACTIVE":
      return "Ese bloqueo ya no está disponible. Actualizá la agenda para ver su estado.";
    case "CALENDAR_BLOCK_STALE":
      return "Ese bloqueo cambió de horario. Actualizá la agenda antes de convertirlo.";
    case "CALENDAR_BLOCK_UNSUPPORTED":
      return "Los eventos de todo el día o recurrentes quedan como bloqueos. Para convertirlo, debe ser un evento individual con hora de inicio y fin.";
    case "CALENDAR_BLOCK_DURATION_INVALID":
      return "El evento debe durar entre 5 minutos y 8 horas, sin segundos. Revisá el inicio y el fin en Google Calendar.";
    case "CALENDAR_BLOCK_IN_PAST":
      return "Ese evento ya comenzó. La conversión está disponible para turnos futuros.";
    case "CALENDAR_BLOCK_CONVERSION_CONFLICT":
      return "Ese evento ya está vinculado a un turno con otros datos. Actualizá la agenda y revisá el turno existente.";
    case "SLOT_UNAVAILABLE":
      return "Ese horario ya no está libre. El bloqueo se mantiene sin cambios.";
    case "COVERAGE_REQUIRED":
      return "Elegí la cobertura del paciente para convertir el evento en turno.";
    case "PATIENT_NAME_REQUIRED":
      return "Completá el nombre y apellido del paciente.";
    case "PATIENT_NAME_INVALID":
      return "Revisá el nombre y apellido: debe tener hasta 120 caracteres.";
    case "CALENDAR_PATIENT_DETAILS_REQUIRED":
      return "Completá la cobertura y confirmá si el paciente ya tenía ficha.";
    case "PATIENT_PHONE_REQUIRED":
    case "PATIENT_PHONE_INVALID":
      return "Completá un número de WhatsApp válido para crear el paciente.";
    case "CONTACT_NOT_FOUND":
      return "Ese paciente ya no está disponible. Volvé a elegirlo o creá su ficha.";
    case "CONTACT_IDENTITY_CONFLICT":
      return "El nombre o WhatsApp coincide con otra ficha o no coincide con el paciente elegido. Revisá los datos y elegí la ficha correcta.";
    case "PROFESSIONAL_NOT_AVAILABLE":
      return "Ese profesional no está disponible. Volvé a elegir quién atiende el turno.";
    case "SERVICE_NOT_AVAILABLE":
      return "Ese servicio no está activo. El bloqueo se mantiene sin cambios.";
    default:
      return "No pudimos comprobar si el bloqueo se convirtió. Actualizá la agenda antes de volver a intentar.";
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
    contactId: string | null;
    patientName?: string | null;
    patientPhone?: string | null;
    coverage?: PatientCoverage | null;
    isExistingPatient?: boolean | null;
    professionalId: string;
    serviceId: string;
    startsAt?: string | null;
    internalNote?: string | null;
    orthodonticVisitType?: OrthodonticVisitType | null;
  },
): Promise<BlockConversionResult> {
  const patientInput =
    !input.contactId ||
    input.coverage != null ||
    input.isExistingPatient != null;
  const params = {
    p_google_event_id: input.googleEventId,
    p_contact_id: input.contactId,
    p_professional_id: input.professionalId,
    p_service_id: input.serviceId,
    p_starts_at: input.startsAt ?? null,
    p_internal_note: input.internalNote?.trim() || null,
    p_orthodontic_visit_type: input.orthodonticVisitType ?? null,
  };
  const { data, error } = await client.rpc(
    patientInput
      ? "convert_google_calendar_block_with_patient"
      : "convert_google_calendar_block_to_appointment",
    patientInput
      ? {
          ...params,
          p_patient_name: input.patientName?.trim() || null,
          p_patient_phone: input.patientPhone?.trim() || null,
          p_coverage: input.coverage ?? null,
          p_is_existing_patient: input.isExistingPatient ?? null,
        }
      : params,
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
  const appointmentId =
    typeof row?.appointment_id === "string" ? row.appointment_id.trim() : "";
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      appointmentId,
    ) ||
    typeof row?.created !== "boolean"
  ) {
    return {
      appointmentId: null,
      created: false,
      error: "UNKNOWN",
    };
  }
  return {
    appointmentId,
    created: row.created,
    error: null,
  };
}
