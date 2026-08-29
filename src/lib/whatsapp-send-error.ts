export interface WhatsAppSendFailure {
  error: string | null;
  message: string | null;
  retryable: boolean | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedText(value: unknown, maximum: number): string | null {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum
    ? value
    : null;
}

export async function readWhatsAppSendFailure(
  data: unknown,
  response?: Response,
): Promise<WhatsAppSendFailure> {
  let payload = record(data);
  if (!payload && response) {
    try {
      payload = record(await response.clone().json());
    } catch {
      // An HTTP failure without a valid JSON contract remains non-retryable
      // from the UI's perspective. It must not promise a safe resend.
    }
  }

  return {
    error: boundedText(payload?.error, 120),
    message: boundedText(payload?.message, 500),
    retryable:
      typeof payload?.retryable === "boolean" ? payload.retryable : null,
  };
}

export function whatsappSendFailureNotice(
  failure: WhatsAppSendFailure,
): string {
  if (failure.message) return failure.message;
  return failure.retryable === true
    ? "No pudimos confirmar el envío. El mismo intento puede reintentarse sin duplicarlo."
    : "El mensaje no fue enviado. Revisá el estado antes de volver a intentar.";
}
