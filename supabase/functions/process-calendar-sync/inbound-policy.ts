import type { ClassifiedGoogleEvent } from "../_shared/google-calendar.ts";

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
  | "skipped_converted";

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
