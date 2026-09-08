export interface CalendarConflictReview {
  conflictId: string;
  imported: true;
  patientName: string;
  local: { title: string; startsAt: string; endsAt: string };
  remote: {
    title: string;
    startsAt: string | null;
    endsAt: string | null;
    updatedAt: string | null;
  };
  reviewToken: string | null;
  canAcceptTitle: boolean;
  reason: string | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown, limit: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= limit
  );
}

function timestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 64 &&
    Number.isFinite(Date.parse(value))
  );
}

/** The browser presents a server-reviewed snapshot; it never decides identity
 * equivalence or creates an approval token on its own. Malformed or stale
 * responses must not expose an enabled acceptance button. */
export function parseCalendarConflictReview(
  value: unknown,
  expectedConflictId: string,
): CalendarConflictReview | null {
  const response = record(value);
  const local = record(response?.local);
  const remote = record(response?.remote);
  if (
    !response ||
    !local ||
    !remote ||
    response.conflictId !== expectedConflictId ||
    response.imported !== true ||
    !text(response.patientName, 160) ||
    !text(local.title, 2000) ||
    !timestamp(local.startsAt) ||
    !timestamp(local.endsAt) ||
    Date.parse(local.startsAt) >= Date.parse(local.endsAt) ||
    typeof remote.title !== "string" ||
    remote.title.length > 2000 ||
    !(remote.startsAt === null || timestamp(remote.startsAt)) ||
    !(remote.endsAt === null || timestamp(remote.endsAt)) ||
    !(remote.updatedAt === null || timestamp(remote.updatedAt)) ||
    typeof response.canAcceptTitle !== "boolean" ||
    !(response.reason === null || text(response.reason, 500)) ||
    !(
      response.reviewToken === null ||
      response.reviewToken === "" ||
      text(response.reviewToken, 64)
    )
  )
    return null;

  if (
    response.canAcceptTitle &&
    (typeof response.reviewToken !== "string" ||
      !/^[0-9a-f]{64}$/.test(response.reviewToken) ||
      response.reason !== null ||
      !remote.title.trim() ||
      !timestamp(remote.startsAt) ||
      !timestamp(remote.endsAt) ||
      Date.parse(remote.startsAt) !== Date.parse(local.startsAt) ||
      Date.parse(remote.endsAt) !== Date.parse(local.endsAt))
  )
    return null;

  return {
    conflictId: expectedConflictId,
    imported: true,
    patientName: response.patientName,
    local: {
      title: local.title,
      startsAt: local.startsAt,
      endsAt: local.endsAt,
    },
    remote: {
      title: remote.title,
      startsAt: remote.startsAt,
      endsAt: remote.endsAt,
      updatedAt: remote.updatedAt,
    },
    reviewToken: response.canAcceptTitle ? response.reviewToken : null,
    canAcceptTitle: response.canAcceptTitle,
    reason: response.reason,
  };
}

export function describeCalendarConflictReviewBlock(
  reason: string | null,
): string {
  // The dedicated ADMIN endpoint returns a bounded, safe explanation. Render
  // it as text, never markup or an arbitrary provider error response.
  return (
    reason ??
    "Este cambio necesita revisión adicional: no podemos aceptar sólo el texto desde acá. El turno no se modificó."
  );
}
