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

const ACTION_LABELS: Record<string, string> = {
  appointment_created: "Se creó un turno",
  appointment_cancelled: "Se canceló un turno",
  appointment_rescheduled: "Se reprogramó un turno",
  appointment_completed: "Se marcó un turno como atendido",
  appointment_no_show: "Se marcó una ausencia",
  deposit_confirmed: "Se confirmó una seña",
  deposit_proof_recorded: "Se asoció un comprobante",
  deposit_proof_reviewed: "Se revisó un comprobante",
  whatsapp_message_sent: "Se envió un mensaje de WhatsApp",
  whatsapp_consent_recorded: "Se registró un consentimiento",
  google_calendar_connected: "Se conectó Google Calendar",
  google_calendar_disconnected: "Se desconectó Google Calendar",
  google_calendar_conflict_applied: "Se aplicó un cambio de Google Calendar",
  google_calendar_conflict_rejected: "Se conservó la versión de la agenda",
  automations_enabled: "Se activó la automatización",
  automations_disabled: "Se apagó la automatización",
};

const DANGER_HINTS = ["cancel", "disconnect", "disabled", "reject", "delete"];
const SUCCESS_HINTS = ["confirmed", "connected", "enabled", "completed"];

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
export function summarizeAuditMetadata(
  metadata: Record<string, unknown>,
  limit = 3,
): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(metadata)) {
    if (parts.length >= limit) break;
    if (value === null || value === undefined) continue;
    if (typeof value === "object") continue;
    const text = String(value);
    parts.push(`${key}: ${text.length > 40 ? `${text.slice(0, 40)}…` : text}`);
  }
  return parts.join(" · ");
}
