const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface DepositProofResult {
  appointmentId: string | null;
  recognized: boolean;
  late: boolean;
  acknowledge: boolean;
}

export function isDepositProofMediaType(value: unknown): boolean {
  return value === "image" || value === "document";
}

/** Normaliza respuestas de PostgREST tanto escalares como tabulares. */
export function normalizeDepositProofResult(
  value: unknown,
): DepositProofResult | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (!candidate || typeof candidate !== "object") return null;

  const row = candidate as Record<string, unknown>;
  const appointmentId =
    typeof row.appointment_id === "string" &&
    UUID_PATTERN.test(row.appointment_id)
      ? row.appointment_id
      : null;
  const explicitlyRecognized =
    typeof row.recognized === "boolean" ? row.recognized : null;
  const recognized = explicitlyRecognized ?? appointmentId !== null;
  if (!recognized || !appointmentId) {
    return {
      appointmentId: null,
      recognized: false,
      late: false,
      acknowledge: false,
    };
  }

  const late = row.late === true;
  return {
    appointmentId,
    recognized: true,
    late,
    acknowledge: !late && row.acknowledge === true,
  };
}
