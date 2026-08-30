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

export interface BasicDepositProofReading {
  legible: boolean;
  amount: number | null;
  currency: string | null;
  date: string | null;
  destination: string | null;
  holder: string | null;
  operationId: string | null;
}

export interface DepositProofValidation {
  approved: boolean;
  reasons: Array<
    | "UNREADABLE"
    | "AMOUNT_MISSING"
    | "AMOUNT_MISMATCH"
    | "RECIPIENT_MISSING"
    | "RECIPIENT_MISMATCH"
  >;
}

function normalizedWords(value: string | null): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("es-AR")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function compactIdentifier(value: string | null): string {
  return normalizedWords(value).replace(/\s+/g, "");
}

function identifierMatches(value: string | null, expected: string): boolean {
  const candidateWords = normalizedWords(value);
  const expectedWords = normalizedWords(expected);
  const candidateCompact = compactIdentifier(value);
  const expectedCompact = compactIdentifier(expected);
  return Boolean(
    candidateWords &&
    expectedWords &&
    (candidateWords === expectedWords ||
      candidateCompact === expectedCompact ||
      (expectedCompact.length >= 6 &&
        candidateCompact.includes(expectedCompact))),
  );
}

function personNameMatches(value: string | null, expected: string): boolean {
  const candidateWords = normalizedWords(value);
  const expectedWords = normalizedWords(expected);
  const candidateCompact = compactIdentifier(value);
  const expectedCompact = compactIdentifier(expected);
  if (
    candidateWords &&
    expectedWords &&
    (candidateWords === expectedWords ||
      candidateCompact === expectedCompact ||
      (expectedCompact.length >= 6 &&
        candidateCompact.includes(expectedCompact)))
  ) {
    return true;
  }
  const candidateTokens = new Set(
    candidateWords.split(" ").filter((token) => token.length >= 2),
  );
  const expectedTokens = expectedWords
    .split(" ")
    .filter((token) => token.length >= 2);
  if (candidateTokens.size < 2 || expectedTokens.length < 2) return false;
  return (
    candidateTokens.has(expectedTokens[0]) &&
    candidateTokens.has(expectedTokens[expectedTokens.length - 1])
  );
}

function recipientMatches(
  reading: BasicDepositProofReading,
  expectedAlias: string,
  expectedHolder: string,
): boolean {
  return (
    identifierMatches(reading.destination, expectedAlias) ||
    personNameMatches(reading.destination, expectedHolder) ||
    identifierMatches(reading.holder, expectedAlias) ||
    personNameMatches(reading.holder, expectedHolder)
  );
}

/**
 * Política deliberadamente simple para el riesgo aceptado por el consultorio:
 * el modelo sólo copia datos; este código exige legibilidad, monto exacto y
 * destinatario. Moneda, fecha e identificador quedan para trazabilidad y nunca
 * bloquean por sí solos una transferencia que cumple esos tres datos básicos.
 */
export function validateDepositProofForAutoConfirmation(input: {
  reading: BasicDepositProofReading;
  expectedAmountArs: number;
  expectedAlias: string;
  expectedHolder: string;
}): DepositProofValidation {
  const reasons: DepositProofValidation["reasons"] = [];
  const { reading } = input;
  if (!reading.legible) reasons.push("UNREADABLE");
  if (reading.amount === null) reasons.push("AMOUNT_MISSING");
  else if (reading.amount !== input.expectedAmountArs) {
    reasons.push("AMOUNT_MISMATCH");
  }

  if (!reading.destination && !reading.holder) {
    reasons.push("RECIPIENT_MISSING");
  } else if (
    !recipientMatches(reading, input.expectedAlias, input.expectedHolder)
  ) {
    reasons.push("RECIPIENT_MISMATCH");
  }

  return { approved: reasons.length === 0, reasons };
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
