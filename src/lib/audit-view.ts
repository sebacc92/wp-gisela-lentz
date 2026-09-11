/**
 * Presentación del registro de actividad.
 *
 * Traduce los códigos internos a algo legible y decide el tono de cada fila.
 * Vive separado de la consulta para poder probar la traducción sin base.
 *
 * Un código desconocido se muestra tal cual, nunca se esconde: el registro
 * sirve justamente para ver lo que no se esperaba.
 */

export type AuditTone = "neutral" | "success" | "warning" | "danger";

/**
 * Traducciones del vocabulario que el sistema escribe de verdad en
 * `audit_logs`, con punto como separador (`appointment.created`). La lista
 * sale de las migraciones y las Functions; lo que no esté acá se muestra
 * tal cual.
 */
const ACTION_LABELS: Record<string, string> = {
  "appointment.created": "Se creó un turno",
  "appointment.updated": "Se modificó un turno",
  "appointment.cancelled": "Se canceló un turno",
  "conversation.state_changed": "Cambió el estado de una conversación",
  "message.operator_sent": "Alguien del equipo envió un mensaje",
  "deposit.confirmed": "Se confirmó una seña",
  "deposit.confirmed_manually": "Se confirmó una seña a mano",
  "deposit.proof_rejected": "Se rechazó un comprobante",
  "deposit.proof_received_late": "Llegó un comprobante fuera de término",
  "deposit.proof_more_requested": "Se pidió otro comprobante",
  "google_calendar.connected": "Se conectó Google Calendar",
  "google_calendar.disconnected": "Se desconectó Google Calendar",
  "google_calendar.conflict_applied": "Se aplicó un cambio de Google Calendar",
  "google_calendar.inbound_import_approved":
    "Se aprobó la importación de Google Calendar",
  "google_calendar.block_converted": "Un bloqueo de Google pasó a turno",
  "google_calendar.block_dismissed": "Se descartó un bloqueo de Google",
  "whatsapp.automations_toggled": "Se encendió o apagó la automatización",
  "whatsapp.automation_resumed_for_last_inbound":
    "La automatización retomó un chat",
  "whatsapp.test_mode_blocked": "El modo de prueba frenó un envío",
  "whatsapp.media_viewed": "Alguien abrió un adjunto",
  "whatsapp.owner_private_answer":
    "Respuesta privada al número del consultorio",
  "whatsapp.embedded_signup.started": "Empezó la conexión de WhatsApp",
  "whatsapp.embedded_signup.completed": "Terminó la conexión de WhatsApp",
  "whatsapp.embedded_signup.failed": "Falló la conexión de WhatsApp",
  "whatsapp.embedded_signup.cancelled": "Se canceló la conexión de WhatsApp",
  "whatsapp.business_token.attention_required":
    "El permiso de Meta necesita atención",
  "whatsapp.business_token.validation_failed":
    "Falló la validación del permiso de Meta",
  "odontogram.entry_recorded": "Se registró un asiento en el odontograma",
  patient_records_merged: "Se unieron dos fichas de paciente",
};

// El orden importa: «disconnected» contiene «connected», así que peligro se
// evalúa primero.
const DANGER_HINTS = [
  "cancel",
  "disconnect",
  "disabled",
  "reject",
  "delete",
  "failed",
  "error",
  "revoked",
  "blocked",
  "late",
];
const SUCCESS_HINTS = [
  "confirmed",
  "connected",
  "enabled",
  "completed",
  "approved",
  "merged",
];

export function describeAuditAction(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

export function auditTone(action: string): AuditTone {
  const value = action.toLowerCase();
  if (DANGER_HINTS.some((hint) => value.includes(hint))) return "danger";
  if (SUCCESS_HINTS.some((hint) => value.includes(hint))) return "success";
  return "neutral";
}

export function webhookTone(status: string): AuditTone {
  const value = status.toLowerCase();
  if (value === "failed" || value === "error") return "danger";
  if (value === "pending") return "warning";
  if (value === "processed" || value === "done") return "success";
  return "neutral";
}

/**
 * Resumen corto de la metadata. Se recortan valores largos y se omiten los
 * objetos anidados: el visor da contexto, no vuelca el registro entero.
 */
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

function formatAuditTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("es-AR", {
    dateStyle: "short",
    timeStyle: "short",
    hourCycle: "h23",
    timeZone: "America/Argentina/Buenos_Aires",
  }).format(date);
}

export function summarizeAuditMetadata(
  metadata: Record<string, unknown>,
  limit = 3,
): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(metadata)) {
    if (parts.length >= limit) break;
    if (value === null || value === undefined) continue;
    if (typeof value === "object") continue;
    const raw = String(value);
    // Una fecha ISO cruda («2026-09-12T12:00:00+00:00») no se lee de un
    // vistazo: se muestra en la zona del consultorio.
    const text = ISO_TIMESTAMP.test(raw) ? formatAuditTimestamp(raw) : raw;
    parts.push(`${key}: ${text.length > 40 ? `${text.slice(0, 40)}…` : text}`);
  }
  return parts.join(" · ");
}
