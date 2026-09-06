import type { SupabaseClient } from "@supabase/supabase-js";
import {
  verifyAppointmentCalendar,
  type CalendarProjectionState,
} from "./calendar-projection.ts";
import { BUSINESS_CONFIG } from "../config/business.ts";

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
): string {
  const fallback = `¡Listo! Tu turno quedó confirmado para el ${date} a las ${time}.`;
  const rendered = template
    .replaceAll("{date}", date)
    .replaceAll("{time}", time)
    .trim();
  return rendered &&
    rendered.length <= 4096 &&
    !/\{[A-Za-z][A-Za-z0-9_]*\}/.test(rendered)
    ? rendered
    : fallback;
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
      .select("deposit_confirmed_message_template")
      .eq("id", true)
      .single();
    const template = String(
      settings?.deposit_confirmed_message_template ?? "",
    ).trim();
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
    const body = renderDepositConfirmationMessage(template, date, time);
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
