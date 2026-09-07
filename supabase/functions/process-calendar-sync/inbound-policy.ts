import {
  type ClassifiedGoogleEvent,
  googleCalendarDateStart,
} from "../_shared/google-calendar.ts";

export const GOOGLE_CALENDAR_SYNC_CONTRACT_VERSION = 2;
export const GOOGLE_CALENDAR_COVERAGE_DAYS = 21;

export interface GoogleCalendarCoverageWindow {
  startsAt: string;
  endsAt: string;
  startDate: string;
  endDateExclusive: string;
  days: number;
  timeZone: string;
}

function calendarDateAt(instant: Date, timeZone: string): string | null {
  if (Number.isNaN(instant.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(instant);
    const value = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((part) => part.type === type)?.value ?? "";
    const year = value("year");
    const month = value("month");
    const day = value("day");
    const date = `${year}-${month}-${day}`;
    return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
  } catch {
    return null;
  }
}

function addCalendarDays(date: string, days: number): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const [year, month, day] = date.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

/**
 * Ventana estable durante cada día del calendario. Incluye hoy y los veinte
 * días siguientes, exactamente el máximo que recorre la reserva automática.
 */
export function googleCalendarCoverageWindow(
  now: Date,
  timeZone: string,
): GoogleCalendarCoverageWindow | null {
  const cleanTimeZone = timeZone.trim();
  const startDate = calendarDateAt(now, cleanTimeZone);
  const endDateExclusive = startDate
    ? addCalendarDays(startDate, GOOGLE_CALENDAR_COVERAGE_DAYS)
    : null;
  if (!startDate || !endDateExclusive) return null;
  const startsAt = googleCalendarDateStart(startDate, cleanTimeZone);
  const endsAt = googleCalendarDateStart(endDateExclusive, cleanTimeZone);
  if (
    !startsAt ||
    !endsAt ||
    new Date(endsAt).getTime() <= new Date(startsAt).getTime()
  ) {
    return null;
  }
  return {
    startsAt,
    endsAt,
    startDate,
    endDateExclusive,
    days: GOOGLE_CALENDAR_COVERAGE_DAYS,
    timeZone: cleanTimeZone,
  };
}

export type CalendarSyncMode =
  | "manual"
  | "preview"
  | "approve_first_import"
  | "initial_import";

export function parseCalendarSyncMode(value: unknown): CalendarSyncMode | null {
  return value === "manual" ||
    value === "preview" ||
    value === "approve_first_import" ||
    value === "initial_import"
    ? value
    : null;
}

/**
 * Un bloqueo que ya terminó no aporta nada a la disponibilidad futura y sólo
 * ensucia la agenda. Se cuenta como visto —para no retirarlo por error en la
 * reconciliación— pero no se importa.
 */
export function shouldImportExternalBlock(input: {
  endsAt: string;
  now: Date;
}): boolean {
  const end = new Date(input.endsAt);
  if (Number.isNaN(end.getTime())) return false;
  return end.getTime() > input.now.getTime();
}

export interface InboundPreviewCounts {
  managed: number;
  externalBlocks: number;
  externalUnsupported: number;
  externalRemoved: number;
  ignored: number;
  pastBlocks: number;
}

export function emptyInboundPreviewCounts(): InboundPreviewCounts {
  return {
    managed: 0,
    externalBlocks: 0,
    externalUnsupported: 0,
    externalRemoved: 0,
    ignored: 0,
    pastBlocks: 0,
  };
}

/**
 * Resumen del preview: sólo cantidades. Nunca títulos ni identificadores, ni
 * siquiera en memoria del informe.
 */
export function countClassifiedEvent(
  counts: InboundPreviewCounts,
  event: ClassifiedGoogleEvent,
  now: Date,
): InboundPreviewCounts {
  switch (event.kind) {
    case "managed":
      return { ...counts, managed: counts.managed + 1 };
    case "external_block":
      return shouldImportExternalBlock({ endsAt: event.endsAt, now })
        ? { ...counts, externalBlocks: counts.externalBlocks + 1 }
        : { ...counts, pastBlocks: counts.pastBlocks + 1 };
    case "external_unsupported":
      return { ...counts, externalUnsupported: counts.externalUnsupported + 1 };
    case "external_removed":
      return { ...counts, externalRemoved: counts.externalRemoved + 1 };
    default:
      return { ...counts, ignored: counts.ignored + 1 };
  }
}

export interface InboundSyncSummary {
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

export type ExternalEventRpcOutcome =
  | "created"
  | "updated"
  | "removed"
  | "unchanged"
  | "already_removed"
  | "skipped_converted"
  | "conflict_recorded"
  | "conflict_pending";

export type ManagedEventRpcOutcome =
  | "conflict_recorded"
  | "conflict_pending"
  | "in_sync"
  | "pending_push"
  | "ignored_unknown_appointment"
  | "ignored_final_appointment"
  | "ignored_invalid_range";

/** Contrato exhaustivo de los RPC inbound. Un valor nuevo falla cerrado hasta
 * que worker, resumen y tests definan explícitamente su semántica. */
export function parseExternalEventRpcOutcome(
  value: unknown,
): ExternalEventRpcOutcome | null {
  switch (value) {
    case "created":
    case "updated":
    case "removed":
    case "unchanged":
    case "already_removed":
    case "skipped_converted":
    case "conflict_recorded":
    case "conflict_pending":
      return value;
    default:
      return null;
  }
}

export function parseManagedEventRpcOutcome(
  value: unknown,
): ManagedEventRpcOutcome | null {
  switch (value) {
    case "conflict_recorded":
    case "conflict_pending":
    case "in_sync":
    case "pending_push":
    case "ignored_unknown_appointment":
    case "ignored_final_appointment":
    case "ignored_invalid_range":
      return value;
    default:
      return null;
  }
}

export function emptyInboundSyncSummary(): InboundSyncSummary {
  return {
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

/** Cambios inbound realmente aplicados; decide si avanza `last_synced_at`. */
export function inboundChangeCount(summary: InboundSyncSummary): number {
  return (
    summary.blocksImported +
    summary.blocksUpdated +
    summary.blocksRemoved +
    summary.conflictsOpened
  );
}

export function applyExternalEventOutcome(
  summary: InboundSyncSummary,
  outcome: ExternalEventRpcOutcome,
): InboundSyncSummary {
  switch (outcome) {
    case "conflict_recorded":
      return { ...summary, conflictsOpened: summary.conflictsOpened + 1 };
    case "conflict_pending":
      return { ...summary, skipped: summary.skipped + 1 };
    case "created":
      return { ...summary, blocksImported: summary.blocksImported + 1 };
    case "updated":
      return { ...summary, blocksUpdated: summary.blocksUpdated + 1 };
    case "removed":
      return { ...summary, blocksRemoved: summary.blocksRemoved + 1 };
    case "unchanged":
      return { ...summary, blocksUnchanged: summary.blocksUnchanged + 1 };
    default:
      return { ...summary, skipped: summary.skipped + 1 };
  }
}

export function applyManagedEventOutcome(
  summary: InboundSyncSummary,
  outcome: ManagedEventRpcOutcome,
): InboundSyncSummary {
  switch (outcome) {
    case "conflict_recorded":
      return { ...summary, conflictsOpened: summary.conflictsOpened + 1 };
    case "in_sync":
      return { ...summary, managedInSync: summary.managedInSync + 1 };
    default:
      return { ...summary, skipped: summary.skipped + 1 };
  }
}

export type CalendarSyncOutcome = "completed" | "partial" | "skipped" | "error";

export interface CalendarSyncOutcomeInput {
  inboundError: string | null;
  inboundSkippedReason: string | null;
  truncated: boolean;
  retried: number;
  failed: number;
  cleanupFailed: number;
}

/**
 * Una ejecución omitida o incompleta nunca puede presentarse como una revisión
 * completa y exitosa: el panel muestra cosas distintas para cada caso.
 */
export function calendarSyncOutcome(
  input: CalendarSyncOutcomeInput,
): CalendarSyncOutcome {
  if (input.inboundError) return "error";
  if (input.inboundSkippedReason) return "skipped";
  if (
    input.truncated ||
    input.retried > 0 ||
    input.failed > 0 ||
    input.cleanupFailed > 0
  ) {
    return "partial";
  }
  return "completed";
}
