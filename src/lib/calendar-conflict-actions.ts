/**
 * Qué se puede decidir sobre un conflicto de Google Calendar.
 *
 * La matriz vive acá, probada, porque elegir mal el lado ganador cambia el
 * turno de un paciente real. Reproduce exactamente las reglas que ya aplicaba
 * el panel de Configuración:
 *
 * - Un turno **importado** de Google es de sólo lectura en la agenda: no se
 *   puede "restaurar desde la agenda", porque la agenda no es su origen. Se
 *   corrige editando el evento en Google.
 * - Un cambio de **texto** (`metadata_changed`) nunca se aplica en bloque: el
 *   único camino es el endpoint de revisión, que acepta el título y no toca ni
 *   el paciente ni el horario.
 * - Todo esto es decisión de ADMIN.
 */

export type CalendarConflictKind =
  | "reschedule_requested"
  | "cancellation_requested"
  | "metadata_changed";

export interface CalendarConflictActions {
  /** `reject_google_calendar_conflict`: gana la agenda y se restaura en Google. */
  canKeepLocal: boolean;
  /** `apply_google_calendar_conflict`: gana Google y se cambia el turno. */
  canApplyRemote: boolean;
  /** Endpoint de revisión: acepta sólo el texto del evento importado. */
  canAcceptTitle: boolean;
  /** Por qué no hay acción directa, cuando no la hay. */
  blockedReason: string | null;
}

export function calendarConflictActions(input: {
  kind: CalendarConflictKind;
  imported: boolean;
  isAdmin: boolean;
}): CalendarConflictActions {
  if (!input.isAdmin) {
    return {
      canKeepLocal: false,
      canApplyRemote: false,
      canAcceptTitle: false,
      blockedReason:
        "Sólo un administrador puede decidir sobre los cambios de Google Calendar.",
    };
  }

  const isMetadata = input.kind === "metadata_changed";
  const canKeepLocal = !input.imported;
  const canApplyRemote = !isMetadata;
  const canAcceptTitle = isMetadata && input.imported;

  let blockedReason: string | null = null;
  if (!canKeepLocal && !canApplyRemote && !canAcceptTitle) {
    blockedReason =
      "Este cambio no se puede decidir desde acá. Editá el evento en Google Calendar y volvé a sincronizar.";
  } else if (input.imported && !canKeepLocal && !isMetadata) {
    blockedReason =
      "Este turno vino de un evento creado en Google Calendar: para conservar el horario actual, editá el evento allá.";
  } else if (isMetadata && !canAcceptTitle) {
    blockedReason =
      "Cambió el texto del evento en Google. El turno de la agenda no se modificó.";
  }

  return { canKeepLocal, canApplyRemote, canAcceptTitle, blockedReason };
}
