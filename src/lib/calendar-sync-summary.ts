import { BUSINESS_CONFIG } from "../config/business.ts";

export interface CalendarSyncSummary {
  pushed: number;
  updatedInGoogle: number;
  deletedInGoogle: number;
  retried: number;
  failed: number;
  blocksImported: number;
  blocksUpdated: number;
  blocksRemoved: number;
  blocksUnchanged: number;
  conflictsOpened: number;
  managedInSync: number;
  skipped: number;
  pagesFetched: number;
  fullResync: boolean;
}

export function emptyCalendarSyncSummary(): CalendarSyncSummary {
  return {
    pushed: 0,
    updatedInGoogle: 0,
    deletedInGoogle: 0,
    retried: 0,
    failed: 0,
    blocksImported: 0,
    blocksUpdated: 0,
    blocksRemoved: 0,
    blocksUnchanged: 0,
    conflictsOpened: 0,
    managedInSync: 0,
    skipped: 0,
    pagesFetched: 0,
    fullResync: false,
  };
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : 0;
}

/** Acepta la respuesta cruda de la Function y descarta cualquier campo ajeno. */
export function parseCalendarSyncSummary(value: unknown): CalendarSyncSummary {
  const source =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return {
    pushed: count(source.pushed),
    updatedInGoogle: count(source.updatedInGoogle),
    deletedInGoogle: count(source.deletedInGoogle),
    retried: count(source.retried),
    failed: count(source.failed),
    blocksImported: count(source.blocksImported),
    blocksUpdated: count(source.blocksUpdated),
    blocksRemoved: count(source.blocksRemoved),
    blocksUnchanged: count(source.blocksUnchanged),
    conflictsOpened: count(source.conflictsOpened),
    managedInSync: count(source.managedInSync),
    skipped: count(source.skipped),
    pagesFetched: count(source.pagesFetched),
    fullResync: source.fullResync === true,
  };
}

export function calendarSyncChangeCount(summary: CalendarSyncSummary): number {
  return (
    summary.pushed +
    summary.updatedInGoogle +
    summary.deletedInGoogle +
    summary.blocksImported +
    summary.blocksUpdated +
    summary.blocksRemoved +
    summary.conflictsOpened
  );
}

export function formatSyncClock(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("es-AR", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: BUSINESS_CONFIG.timezone,
  }).format(date);
}

function pluralize(value: number, singular: string, plural: string): string {
  return `${value} ${value === 1 ? singular : plural}`;
}

/**
 * Mensaje que ve Gisela después de tocar «Sincronizar ahora». Nunca incluye
 * nombres, títulos de eventos ni identificadores: sólo cantidades.
 */
export function describeCalendarSync(input: {
  summary: CalendarSyncSummary;
  checkedAt?: string | Date | null;
  skippedReason?: string | null;
  error?: string | null;
}): string {
  const { summary } = input;
  if (input.error) {
    return "No pudimos completar la revisión del calendario. Los turnos siguen guardados de forma segura acá.";
  }
  if (input.skippedReason === "FIRST_IMPORT_APPROVAL_REQUIRED") {
    return "Los turnos se enviaron a Google. Para traer los eventos que ya existen en Google falta aprobar la primera importación.";
  }
  if (input.skippedReason === "INBOUND_SYNC_IN_PROGRESS") {
    return "Ya había una sincronización en curso. Esperá unos segundos y volvé a intentar.";
  }

  const parts: string[] = [];
  if (summary.pushed > 0) {
    parts.push(pluralize(summary.pushed, "enviado", "enviados"));
  }
  if (summary.updatedInGoogle > 0) {
    parts.push(
      pluralize(summary.updatedInGoogle, "actualizado", "actualizados"),
    );
  }
  if (summary.deletedInGoogle > 0) {
    parts.push(pluralize(summary.deletedInGoogle, "eliminado", "eliminados"));
  }
  if (summary.blocksImported > 0) {
    parts.push(pluralize(summary.blocksImported, "importado", "importados"));
  }
  if (summary.blocksUpdated > 0) {
    parts.push(
      pluralize(
        summary.blocksUpdated,
        "bloqueo cambiado",
        "bloqueos cambiados",
      ),
    );
  }
  if (summary.blocksRemoved > 0) {
    parts.push(
      pluralize(
        summary.blocksRemoved,
        "bloqueo retirado",
        "bloqueos retirados",
      ),
    );
  }
  if (summary.conflictsOpened > 0) {
    parts.push(
      pluralize(
        summary.conflictsOpened,
        "cambio para revisar",
        "cambios para revisar",
      ),
    );
  }

  const clock = input.checkedAt ? formatSyncClock(input.checkedAt) : "";
  if (parts.length === 0) {
    const suffix = clock ? ` Calendario revisado a las ${clock}.` : "";
    return `Sin cambios.${suffix}`.trim();
  }

  parts.push(pluralize(summary.failed, "error", "errores"));
  const skipped =
    summary.skipped > 0
      ? ` ${pluralize(summary.skipped, "evento omitido", "eventos omitidos")}.`
      : "";
  return `Sincronización completada: ${parts.join(", ")}.${skipped}`;
}
