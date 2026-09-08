export interface GoogleCalendarOperationalStatus {
  configured: boolean;
  connected: boolean;
  automationActive: boolean;
  lastSuccessfulReviewAt: string;
  pendingCount: number;
  failedCount: number;
  conflictCount: number;
  hasSyncError: boolean;
  firstImportApproved: boolean;
  inboundSyncState: string;
  status: string;
}

export type GoogleCalendarOperationalKind =
  | "healthy"
  | "inactive"
  | "pending"
  | "attention"
  | "not_ready"
  | "disconnected";

export interface GoogleCalendarOperationalView {
  kind: GoogleCalendarOperationalKind;
  title: string;
  detail: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function timestamp(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "";
  return Number.isNaN(Date.parse(value)) ? "" : value;
}

const knownStatuses = new Set([
  "connected",
  "synced",
  "disconnected",
  "reconnect_required",
  "pending",
  "error",
  "incomplete",
  "attention",
  "first_import_required",
  "initial_sync_required",
  "selection_required",
]);

/**
 * Decodifica únicamente el resumen operativo. Identidad de cuenta, calendario,
 * eventos y pacientes se descartan aun si el endpoint los incluyera.
 */
export function parseGoogleCalendarOperationalStatus(
  value: unknown,
): GoogleCalendarOperationalStatus | null {
  const source = record(value);
  if (!source) return null;

  const pendingCount = count(source.pendingCount);
  const failedCount = count(source.failedCount);
  const conflictCount = count(source.conflictCount);
  const status = typeof source.status === "string" ? source.status : "";
  if (
    typeof source.configured !== "boolean" ||
    typeof source.connected !== "boolean" ||
    typeof source.firstImportApproved !== "boolean" ||
    pendingCount === null ||
    failedCount === null ||
    conflictCount === null ||
    !knownStatuses.has(status)
  ) {
    return null;
  }

  return {
    configured: source.configured,
    connected: source.connected,
    // La ausencia del campo y cualquier valor ambiguo son posición inactiva.
    // Nunca se infiere automatización a partir de la conexión o un timestamp.
    automationActive: source.automationActive === true,
    lastSuccessfulReviewAt: timestamp(source.lastSyncCompletedAt),
    pendingCount,
    failedCount,
    conflictCount,
    hasSyncError:
      typeof source.lastSyncError === "string" &&
      /^[A-Z0-9_]{3,100}$/.test(source.lastSyncError),
    firstImportApproved: source.firstImportApproved,
    inboundSyncState:
      typeof source.inboundSyncState === "string"
        ? source.inboundSyncState
        : "",
    status,
  };
}

export function googleCalendarOperationalView(
  status: GoogleCalendarOperationalStatus,
): GoogleCalendarOperationalView {
  if (!status.configured || !status.connected) {
    return {
      kind: "disconnected",
      title: status.configured
        ? "Google Calendar no está conectado"
        : "Google Calendar no está configurado",
      detail: "La agenda de la aplicación sigue disponible.",
    };
  }

  if (status.conflictCount > 0) {
    const plural = status.conflictCount === 1 ? "cambio" : "cambios";
    return {
      kind: "attention",
      title: `Google Calendar tiene ${status.conflictCount} ${plural} para revisar`,
      detail:
        "Sincronizar no decide estos cambios. Revisalos y elegí qué versión conservar.",
    };
  }

  if (
    status.status === "reconnect" ||
    status.status === "reconnect_required" ||
    status.status === "error" ||
    status.status === "attention" ||
    status.inboundSyncState === "full_resync_required" ||
    status.failedCount > 0 ||
    status.hasSyncError
  ) {
    return {
      kind: "attention",
      title: "Google Calendar necesita revisión",
      detail:
        "Hay cambios o errores pendientes. Revisalos antes de depender de la sincronización.",
    };
  }

  if (
    !status.firstImportApproved ||
    status.inboundSyncState !== "incremental" ||
    !status.lastSuccessfulReviewAt
  ) {
    return {
      kind: "not_ready",
      title: "Google Calendar todavía no está listo",
      detail: "Falta completar una revisión exitosa del calendario.",
    };
  }

  if (status.pendingCount > 0 || status.status === "pending") {
    return {
      kind: "pending",
      title: "Google Calendar tiene cambios pendientes",
      detail: "La agenda permanece guardada mientras terminan de procesarse.",
    };
  }

  if (status.status !== "connected" && status.status !== "synced") {
    return {
      kind: "attention",
      title: "No pudimos confirmar el estado de Google Calendar",
      detail:
        "Volvé a consultar el estado antes de depender de la sincronización.",
    };
  }

  if (!status.automationActive) {
    return {
      kind: "inactive",
      title: "Automatización de Calendar no activada",
      detail: "Podés revisar el calendario manualmente desde este panel.",
    };
  }

  return {
    kind: "healthy",
    title: "Google Calendar está al día",
    detail: "La automatización está activa y la última revisión terminó bien.",
  };
}
