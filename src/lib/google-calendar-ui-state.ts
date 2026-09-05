export type GoogleCalendarSyncStatus =
  | "synced"
  | "pending"
  | "attention"
  | "reconnect"
  | "first_import"
  | "not_checked";

export interface GoogleCalendarSyncStateInput {
  status: unknown;
  firstImportApproved: boolean;
  inboundSyncState: string;
  lastCheckedAt: string;
}

function hasValidReviewTimestamp(value: string): boolean {
  return value.trim().length > 0 && !Number.isNaN(new Date(value).getTime());
}

/**
 * Estado conservador para el panel: una conexión no equivale a una
 * sincronización completa. «Todo al día» sólo corresponde después de aprobar
 * la importación inicial y completar al menos una revisión incremental.
 */
export function googleCalendarSyncStatus({
  status,
  firstImportApproved,
  inboundSyncState,
  lastCheckedAt,
}: GoogleCalendarSyncStateInput): GoogleCalendarSyncStatus {
  const normalizedStatus = String(status);

  if (
    ["reconnect", "reconnect_required", "expired"].includes(normalizedStatus)
  ) {
    return "reconnect";
  }
  if (["attention", "error"].includes(normalizedStatus)) return "attention";
  if (["pending", "syncing", "queued"].includes(normalizedStatus)) {
    return "pending";
  }
  if (
    !firstImportApproved ||
    ["first_import_required", "setup_required"].includes(normalizedStatus)
  ) {
    return "first_import";
  }
  if (["initial_sync_required", "not_checked"].includes(normalizedStatus)) {
    return "not_checked";
  }
  if (inboundSyncState === "full_resync_required") return "attention";
  if (
    inboundSyncState !== "incremental" ||
    !hasValidReviewTimestamp(lastCheckedAt)
  ) {
    return "not_checked";
  }
  if (["connected", "synced"].includes(normalizedStatus)) return "synced";

  return "attention";
}

export function canRunManualGoogleCalendarSync(
  firstImportApproved: boolean,
): boolean {
  return firstImportApproved;
}
