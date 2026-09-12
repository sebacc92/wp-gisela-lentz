import type { SupabaseClient } from "@supabase/supabase-js";
import {
  verifyAppointmentCalendar,
  type CalendarProjectionState,
} from "./calendar-projection.ts";
import { BUSINESS_CONFIG } from "../config/business.ts";

function formatPart(date: Date, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat("es-AR", {
    ...options,
    timeZone: BUSINESS_CONFIG.timezone,
  }).format(date);
}

export interface CreatedAppointmentResult {
  id: string;
  depositRequired: boolean;
}

export function createdAppointmentFromRpc(
  data: unknown,
): CreatedAppointmentResult | null {
  const value = Array.isArray(data) ? data[0] : data;
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || !row.id) return null;
  return {
    id: row.id,
    depositRequired: row.deposit_status === "pending",
  };
}

function formatDepositAmountArs(amount: number): string {
  return `$${new Intl.NumberFormat("es-AR", {
    maximumFractionDigits: 0,
  }).format(amount)}`;
}

function renderRequest(
  template: string,
  values: Record<string, string>,
): string {
  return template
    .replace(/\{([a-z][a-z0-9_]*)\}/g, (placeholder, key: string) =>
      Object.prototype.hasOwnProperty.call(values, key)
        ? values[key]
        : placeholder,
    )
    .trim();
}

export async function requestDepositAndNotify(
  client: SupabaseClient,
  input: {
    appointmentId: string;
    contactId: string;
    depositRequired: boolean;
    conversationId?: string;
  },
): Promise<{
  required: boolean;
  notified: boolean;
  calendarState?: CalendarProjectionState;
}> {
  const calendarState = await verifyAppointmentCalendar(
    client,
    input.appointmentId,
  );
  if (calendarState !== "synced")
    return { required: input.depositRequired, notified: false, calendarState };
  if (!input.depositRequired) return { required: false, notified: false };

  // La reserva ya existe. Desde acá el aviso es best-effort y nunca debe
  // borrar ni presentar como fallida una pre-reserva válida.
  try {
    const { data: settings, error: settingsError } = await client
      .from("app_settings")
      .select(
        "deposit_enabled,deposit_amount_ars,deposit_alias,deposit_holder,deposit_request_message_template",
      )
      .eq("id", true)
      .single();
    if (settingsError || settings?.deposit_enabled !== true) {
      return { required: input.depositRequired, notified: false };
    }

    const amount = Number(settings.deposit_amount_ars);
    const alias = String(settings.deposit_alias ?? "").trim();
    const holder = String(settings.deposit_holder ?? "").trim();
    const template = String(
      settings.deposit_request_message_template ?? "",
    ).trim();
    if (
      !Number.isSafeInteger(amount) ||
      amount <= 0 ||
      !alias ||
      !holder ||
      !template
    ) {
      return { required: true, notified: false };
    }

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
    if (!conversationId) return { required: true, notified: false };

    // El pedido nombra el día y la hora que se están reservando, así que se
    // leen del turno recién creado.
    const { data: appointment } = await client
      .from("appointments")
      .select("starts_at")
      .eq("id", input.appointmentId)
      .maybeSingle();
    const startsAt = String(appointment?.starts_at ?? "");
    const scheduled = startsAt ? new Date(startsAt) : null;
    const body = renderRequest(template, {
      deposit_amount: formatDepositAmountArs(amount),
      deposit_alias: alias,
      deposit_holder: holder,
      ...(scheduled && Number.isFinite(scheduled.getTime())
        ? {
            date: formatPart(scheduled, {
              weekday: "long",
              day: "numeric",
              month: "long",
            }),
            time: formatPart(scheduled, {
              hour: "2-digit",
              minute: "2-digit",
              hour12: false,
            }),
          }
        : {}),
    });
    // Una llave sin resolver viajaría literal al paciente: mejor no mandarlo.
    if (!body || body.length > 4096 || /\{[a-z][a-z0-9_]*\}/.test(body)) {
      return { required: true, notified: false };
    }
    const { data, error } = await client.functions.invoke("whatsapp-send", {
      body: {
        conversationId,
        body,
        idempotencyKey: `deposit-request-${input.appointmentId}`,
        purpose: "operator_deposit_request",
        appointmentId: input.appointmentId,
      },
    });
    return { required: true, notified: !error && !data?.error };
  } catch {
    return { required: true, notified: false };
  }
}
