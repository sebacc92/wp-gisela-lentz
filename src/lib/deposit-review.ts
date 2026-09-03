import type { SupabaseClient } from "@supabase/supabase-js";
import { BUSINESS_CONFIG } from "../config/business.ts";
import { renderDepositConfirmationMessage } from "./deposit-confirmation.ts";

export const DEPOSIT_PROOF_REJECTED_MESSAGE =
  "Revisamos el comprobante y no pudimos validarlo. Escribinos por este chat y lo resolvemos.";

export const DEPOSIT_PROOF_RETRY_MESSAGE =
  "No pudimos verificar el comprobante. ¿Podés enviarnos una imagen más clara?";

function formatPart(startsAt: string, options: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat("es-AR", {
    ...options,
    timeZone: BUSINESS_CONFIG.timezone,
  }).format(new Date(startsAt));
}

async function openConversationId(
  client: SupabaseClient,
  contactId: string,
): Promise<string | null> {
  const { data } = await client
    .from("conversations")
    .select("id")
    .eq("contact_id", contactId)
    .eq("status", "open")
    .maybeSingle();
  return (data?.id as string | undefined) ?? null;
}

async function sendOperatorMessage(
  client: SupabaseClient,
  input: {
    contactId: string;
    body: string;
    idempotencyKey: string;
    conversationId?: string;
  },
): Promise<boolean> {
  try {
    const conversationId =
      input.conversationId ??
      (await openConversationId(client, input.contactId));
    if (!conversationId) return false;
    const { data, error } = await client.functions.invoke("whatsapp-send", {
      body: {
        conversationId,
        body: input.body,
        idempotencyKey: input.idempotencyKey,
        purpose: "operator_message",
      },
    });
    return !error && !data?.error;
  } catch {
    return false;
  }
}

export type DepositConfirmationError =
  | "ADMIN_REQUIRED"
  | "APPOINTMENT_NOT_SCHEDULED"
  | "APPOINTMENT_ALREADY_STARTED"
  | "SLOT_NO_LONGER_AVAILABLE"
  | "UNKNOWN";

export interface ManualDepositConfirmation {
  confirmed: boolean;
  alreadyConfirmed: boolean;
  notified: boolean;
  error: DepositConfirmationError | null;
}

/** Los códigos del RPC son estables; cualquier otra cosa se reporta genérica. */
export function depositConfirmationError(
  message: unknown,
): DepositConfirmationError {
  const text = typeof message === "string" ? message : "";
  if (text.includes("ADMIN_REQUIRED")) return "ADMIN_REQUIRED";
  if (text.includes("SLOT_NO_LONGER_AVAILABLE")) {
    return "SLOT_NO_LONGER_AVAILABLE";
  }
  if (text.includes("APPOINTMENT_ALREADY_STARTED")) {
    return "APPOINTMENT_ALREADY_STARTED";
  }
  if (text.includes("APPOINTMENT_NOT_SCHEDULED")) {
    return "APPOINTMENT_NOT_SCHEDULED";
  }
  return "UNKNOWN";
}

/** Explica qué acción corresponde, en vez de un "no pudimos" sin salida. */
export function describeDepositConfirmationError(
  error: DepositConfirmationError,
): string {
  switch (error) {
    case "SLOT_NO_LONGER_AVAILABLE":
      return "La reserva venció y ese horario ya está ocupado. Reprogramá el turno antes de confirmar la seña.";
    case "APPOINTMENT_ALREADY_STARTED":
      return "La reserva venció y el horario ya pasó. Reprogramá el turno para poder confirmarlo.";
    case "APPOINTMENT_NOT_SCHEDULED":
      return "Este turno ya no está pendiente de seña. Actualizá la agenda para ver su estado.";
    case "ADMIN_REQUIRED":
      return "Confirmar una seña lo hace la persona administradora.";
    default:
      return "No pudimos confirmar la seña. No se hicieron cambios; intentá de nuevo.";
  }
}

/**
 * Confirmación manual de la seña. No depende de que la IA haya podido leer el
 * comprobante, ni de que el hold siga vigente: es una decisión de la persona
 * ADMIN y la autorización se verifica en el RPC, no acá.
 */
export async function confirmDepositManually(
  client: SupabaseClient,
  input: {
    appointmentId: string;
    contactId: string;
    startsAt: string;
    conversationId?: string;
  },
): Promise<ManualDepositConfirmation> {
  const { data, error } = await client.rpc(
    "admin_confirm_appointment_deposit",
    { p_appointment_id: input.appointmentId },
  );
  if (error) {
    return {
      confirmed: false,
      alreadyConfirmed: false,
      notified: false,
      error: depositConfirmationError(error.message),
    };
  }
  const row = (Array.isArray(data) ? data[0] : data) as {
    already_confirmed?: boolean;
  } | null;
  const alreadyConfirmed = row?.already_confirmed === true;

  // Un segundo clic no vuelve a escribirle al paciente. Además la clave de
  // idempotencia del envío es la misma que usa el flujo automático.
  if (alreadyConfirmed) {
    return {
      confirmed: true,
      alreadyConfirmed: true,
      notified: false,
      error: null,
    };
  }

  let notified = false;
  try {
    const conversationId =
      input.conversationId ??
      (await openConversationId(client, input.contactId));
    if (conversationId) {
      const { data: settings } = await client
        .from("app_settings")
        .select("deposit_confirmed_message_template")
        .eq("id", true)
        .single();
      const body = renderDepositConfirmationMessage(
        String(settings?.deposit_confirmed_message_template ?? "").trim(),
        formatPart(input.startsAt, {
          weekday: "long",
          day: "numeric",
          month: "long",
        }),
        formatPart(input.startsAt, {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }),
      );
      const { data: sent, error: sendError } = await client.functions.invoke(
        "whatsapp-send",
        {
          body: {
            conversationId,
            body,
            idempotencyKey: `deposit-confirm-${input.appointmentId}`,
            purpose: "operator_deposit_confirmation",
            appointmentId: input.appointmentId,
          },
        },
      );
      notified = !sendError && !sent?.error;
    }
  } catch {
    notified = false;
  }

  return { confirmed: true, alreadyConfirmed: false, notified, error: null };
}

export type DepositReviewDecision = "rejected" | "more_requested";

export interface DepositReviewResult {
  changed: boolean;
  notified: boolean;
  error: string | null;
}

export async function reviewDepositProof(
  client: SupabaseClient,
  input: {
    appointmentId: string;
    contactId: string;
    decision: DepositReviewDecision;
    notify: boolean;
    conversationId?: string;
  },
): Promise<DepositReviewResult> {
  const { data, error } = await client.rpc("admin_review_deposit_proof", {
    p_appointment_id: input.appointmentId,
    p_decision: input.decision,
    p_reason: null,
  });
  if (error) {
    return {
      changed: false,
      notified: false,
      error: error.message ?? "UNKNOWN",
    };
  }
  const row = (Array.isArray(data) ? data[0] : data) as {
    review_id?: string | null;
    changed?: boolean;
  } | null;
  if (row?.changed !== true) {
    // Otra persona ya resolvió este comprobante: no se manda un segundo aviso.
    return { changed: false, notified: false, error: null };
  }

  if (!input.notify) return { changed: true, notified: false, error: null };
  const notified = await sendOperatorMessage(client, {
    contactId: input.contactId,
    conversationId: input.conversationId,
    body:
      input.decision === "rejected"
        ? DEPOSIT_PROOF_REJECTED_MESSAGE
        : DEPOSIT_PROOF_RETRY_MESSAGE,
    idempotencyKey: `deposit-${input.decision}-${row.review_id ?? input.appointmentId}`,
  });
  return { changed: true, notified, error: null };
}
