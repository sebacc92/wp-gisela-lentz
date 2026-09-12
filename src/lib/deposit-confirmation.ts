import type { SupabaseClient } from "@supabase/supabase-js";
import {
  verifyAppointmentCalendar,
  type CalendarProjectionState,
} from "./calendar-projection.ts";
import { BUSINESS_CONFIG } from "../config/business.ts";
import { appendArrivalNotice } from "./arrival-notice.ts";

function formatPart(startsAt: string, options: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat("es-AR", {
    ...options,
    timeZone: BUSINESS_CONFIG.timezone,
  }).format(new Date(startsAt));
}

export function renderDepositConfirmationMessage(
  template: string,
  date: string,
  time: string,
  address = "",
): string {
  const fallback = `¡Listo! Tu turno quedó confirmado para el ${date} a las ${time}.`;
  const rendered = template
    .replaceAll("{date}", date)
    .replaceAll("{time}", time)
    .replaceAll("{address}", address)
    .trim();
  return rendered &&
    rendered.length <= 4096 &&
    !/\{[A-Za-z][A-Za-z0-9_]*\}/.test(rendered)
    ? rendered
    : fallback;
}

/**
 * Cuerpo completo del aviso de seña confirmada: la plantilla configurada con
 * fecha, hora y dirección, más el aviso de la puerta si el turno cae en la
 * franja sin atención administrativa. Lo comparten la bandeja y la cola de
 * revisión para que las dos manden exactamente el mismo mensaje.
 */
export function depositConfirmationBody(input: {
  template: string;
  startsAt: string;
  address?: string;
}): string {
  const date = formatPart(input.startsAt, {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
  const time = formatPart(input.startsAt, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return appendArrivalNotice(
    renderDepositConfirmationMessage(
      input.template,
      date,
      time,
      input.address ?? "",
    ),
    input.startsAt,
    BUSINESS_CONFIG.timezone,
  );
}

export async function confirmDepositAndNotify(
  client: SupabaseClient,
  input: {
    appointmentId: string;
    contactId: string;
    startsAt: string;
    conversationId?: string;
  },
): Promise<{
  confirmed: boolean;
  notified: boolean;
  calendarState?: CalendarProjectionState;
}> {
  const { error } = await client.rpc("confirm_appointment_deposit", {
    p_appointment_id: input.appointmentId,
  });
  if (error) return { confirmed: false, notified: false };
  const calendarState = await verifyAppointmentCalendar(
    client,
    input.appointmentId,
  );
  if (calendarState !== "synced")
    return { confirmed: true, notified: false, calendarState };

  // Todo lo que sigue es best-effort: la confirmación ya está auditada y un
  // problema de WhatsApp no debe deshacerla ni informarla como fallida.
  try {
    let conversationId = input.conversationId;
    if (!conversationId) {
      const { data: conversation } = await client
        .from("conversations")
        .select("id")
        .eq("contact_id", input.contactId)
        .eq("status", "open")
        .maybeSingle();
      conversationId = conversation?.id as string | undefined;
    }
    if (!conversationId) return { confirmed: true, notified: false };

    const { data: settings } = await client
      .from("app_settings")
      .select("deposit_confirmed_message_template,business_address")
      .eq("id", true)
      .single();
    const body = depositConfirmationBody({
      template: String(
        settings?.deposit_confirmed_message_template ?? "",
      ).trim(),
      startsAt: input.startsAt,
      address: String(settings?.business_address ?? "").trim(),
    });
    const { data, error: sendError } = await client.functions.invoke(
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
    return {
      confirmed: true,
      notified: !sendError && !data?.error,
    };
  } catch {
    return { confirmed: true, notified: false };
  }
}
