import {
  jsonResponse,
  optionsResponse,
  safeErrorMessage,
} from "../_shared/http.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import {
  DEFAULT_BUSINESS_TIMEZONE,
  formatAppointmentDate,
  formatAppointmentTime,
  hasActiveWhatsAppConsent,
  isWhatsAppPolicyError,
  sendAndRecordMessage,
  shouldRetryWhatsAppError,
  templatePayload,
  textPayload,
  WhatsAppPolicyError,
  whatsappAutomationsEnabled,
  type WhatsAppContact,
  type WhatsAppConversation,
} from "../_shared/whatsapp.ts";
import {
  isAppointmentTomorrow,
  isExpiredHoldNotificationEligible,
  isReminderEligibleAppointment,
  reminderTemplateKey,
  type ReminderType,
} from "./reminder-schedule.ts";

interface ReminderRow {
  id: string;
  appointment_id: string;
  type: ReminderType;
  attempts: number;
}

interface QueueResult {
  queued: number | string;
  already_queued: number | string;
}

interface ExpiredHoldNotificationRow {
  appointment_id: string;
  contact_id: string;
  attempts: number;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return optionsResponse(request);
  if (request.method !== "POST") {
    return jsonResponse(request, { error: "METHOD_NOT_ALLOWED" }, 405);
  }

  const expected = Deno.env.get("REMINDER_CRON_SECRET")?.trim();
  const provided = request.headers.get("x-cron-secret")?.trim();
  if (!expected || provided !== expected) {
    return jsonResponse(request, { error: "UNAUTHORIZED" }, 401);
  }

  const client = createServiceClient();
  const { data: expiredRows, error: expirationError } = await client.rpc(
    "expire_booking_holds",
    {},
  );
  if (expirationError) {
    console.error("process-reminders", "HOLD_EXPIRATION_FAILED");
    return jsonResponse(request, { error: "HOLD_EXPIRATION_FAILED" }, 500);
  }
  const expiredHolds = Array.isArray(expiredRows) ? expiredRows.length : 0;

  if (!whatsappAutomationsEnabled()) {
    return jsonResponse(request, {
      processed: false,
      ignored: true,
      reason: "AUTOMATIONS_DISABLED",
      expired_holds: expiredHolds,
    });
  }

  const { data: appSettings, error: settingsError } = await client
    .from("app_settings")
    .select("timezone,booking_hold_expired_message_template")
    .eq("id", true)
    .single();
  if (settingsError) {
    console.error("process-reminders", "SETTINGS_UNAVAILABLE");
    return jsonResponse(request, { error: "SETTINGS_UNAVAILABLE" }, 500);
  }
  const businessTimezone =
    typeof appSettings?.timezone === "string" && appSettings.timezone.trim()
      ? appSettings.timezone.trim()
      : DEFAULT_BUSINESS_TIMEZONE;

  const holdExpirationMessage =
    typeof appSettings?.booking_hold_expired_message_template === "string"
      ? appSettings.booking_hold_expired_message_template.trim()
      : "";
  let expiredNotificationsSent = 0;
  let expiredNotificationsFailed = 0;
  let expiredNotificationsCancelled = 0;

  if (holdExpirationMessage) {
    const { data: expiredClaims, error: expiredClaimError } = await client.rpc(
      "claim_expired_booking_hold_notifications",
      { p_limit: 10 },
    );
    if (expiredClaimError) {
      console.error("process-reminders", "HOLD_NOTIFICATION_CLAIM_FAILED");
      return jsonResponse(
        request,
        { error: "HOLD_NOTIFICATION_CLAIM_FAILED" },
        500,
      );
    }

    for (const claim of (expiredClaims ?? []) as ExpiredHoldNotificationRow[]) {
      try {
        const { data: appointment, error: appointmentError } = await client
          .from("appointments")
          .select(
            "id,contact_id,status,deposit_status,deposit_proof_late,hold_expired_notification_status,contacts!appointments_contact_id_fkey(id,phone_e164,whatsapp_id,whatsapp_user_id,name,whatsapp_opt_in_at,whatsapp_opt_out_at,whatsapp_consent_status)",
          )
          .eq("id", claim.appointment_id)
          .single();
        if (appointmentError || !appointment) {
          throw new Error("HOLD_APPOINTMENT_NOT_FOUND");
        }
        if (
          !isExpiredHoldNotificationEligible({
            status: appointment.status as string,
            depositStatus: appointment.deposit_status as string,
            depositProofLate: appointment.deposit_proof_late === true,
            notificationStatus:
              appointment.hold_expired_notification_status as string,
          })
        ) {
          throw new WhatsAppPolicyError("HOLD_EXPIRATION_STALE");
        }

        const contactRelation = appointment.contacts as
          | WhatsAppContact
          | WhatsAppContact[]
          | null;
        const contact = Array.isArray(contactRelation)
          ? contactRelation[0]
          : contactRelation;
        if (!contact) throw new Error("CONTACT_NOT_FOUND");

        const { data: conversationResult, error: conversationError } =
          await client.rpc("get_or_create_open_conversation", {
            p_contact_id: appointment.contact_id,
          });
        if (conversationError || !conversationResult) {
          throw new Error("CONVERSATION_NOT_FOUND");
        }
        const conversation = Array.isArray(conversationResult)
          ? conversationResult[0]
          : conversationResult;

        const outbound = await sendAndRecordMessage({
          client,
          conversation: conversation as WhatsAppConversation,
          contact,
          payload: textPayload(holdExpirationMessage),
          bodyPreview: holdExpirationMessage,
          idempotencyKey: `hold-expiration:${claim.appointment_id}`,
          appointmentId: claim.appointment_id,
          metadata: {
            source: "hold_expiration",
            appointment_id: claim.appointment_id,
          },
        });
        if (!["sent", "delivered", "read"].includes(outbound.status)) {
          throw new Error(`HOLD_NOTIFICATION_${outbound.status.toUpperCase()}`);
        }

        const { data: completed, error: completeError } = await client.rpc(
          "complete_expired_booking_hold_notification",
          { p_appointment_id: claim.appointment_id },
        );
        if (completeError) throw new Error("HOLD_NOTIFICATION_COMPLETE_FAILED");
        if (completed === true) expiredNotificationsSent += 1;
        else expiredNotificationsCancelled += 1;
      } catch (error) {
        const policyBlocked = isWhatsAppPolicyError(error);
        // Las fallas locales/DB también pueden ser transitorias. El RPC limita
        // los intentos a tres; las políticas de seguridad sí quedan terminales.
        const retryable = !policyBlocked;
        const errorCode = policyBlocked
          ? `WHATSAPP_POLICY:${error.code}`
          : retryable
            ? "SEND_RETRYABLE"
            : "SEND_FAILED";
        await client.rpc("fail_expired_booking_hold_notification", {
          p_appointment_id: claim.appointment_id,
          p_error_code: errorCode,
          p_retryable: retryable,
        });
        if (policyBlocked) expiredNotificationsCancelled += 1;
        else expiredNotificationsFailed += 1;
        console.error("process-reminders", claim.appointment_id, errorCode);
      }
    }
  } else {
    console.warn("process-reminders", "HOLD_NOTIFICATION_NOT_CONFIGURED");
  }

  const { data: queueData, error: queueError } = await client.rpc(
    "queue_tomorrow_appointment_reminders",
    {},
  );
  if (queueError) {
    console.error("queue_tomorrow_appointment_reminders", queueError.message);
    return jsonResponse(request, { error: "QUEUE_FAILED" }, 500);
  }
  const queueResult = ((queueData ?? []) as QueueResult[])[0];
  const queuedTomorrow = Number(queueResult?.queued ?? 0);
  const alreadyQueuedTomorrow = Number(queueResult?.already_queued ?? 0);

  const { data: claimed, error: claimError } = await client.rpc(
    "claim_due_reminders",
    { p_limit: 25 },
  );
  if (claimError) {
    console.error("claim_due_reminders", claimError.message);
    return jsonResponse(request, { error: "CLAIM_FAILED" }, 500);
  }

  let sent = 0;
  let failed = 0;
  let cancelled = 0;

  for (const reminder of (claimed ?? []) as ReminderRow[]) {
    try {
      const { data: appointment, error: appointmentError } = await client
        .from("appointments")
        .select(
          "id,contact_id,professional_id,starts_at,status,contacts!appointments_contact_id_fkey(id,phone_e164,whatsapp_id,whatsapp_user_id,name,whatsapp_opt_in_at,whatsapp_opt_out_at,whatsapp_consent_status),professionals!appointments_professional_id_fkey(name)",
        )
        .eq("id", reminder.appointment_id)
        .single();
      if (appointmentError || !appointment)
        throw new Error("APPOINTMENT_NOT_FOUND");

      if (
        !isReminderEligibleAppointment(
          appointment.status as string,
          appointment.starts_at as string,
        )
      ) {
        await client
          .from("reminders")
          .update({
            status: "cancelled",
            processing_started_at: null,
            last_error: "APPOINTMENT_NOT_ACTIVE",
          })
          .eq("id", reminder.id);
        cancelled += 1;
        continue;
      }

      const startsAt = appointment.starts_at as string;
      if (
        reminder.type === "appointment_24h" &&
        !isAppointmentTomorrow(startsAt, new Date(), businessTimezone)
      ) {
        await client
          .from("reminders")
          .update({
            status: "cancelled",
            processing_started_at: null,
            last_error: "REMINDER_WINDOW_EXPIRED",
          })
          .eq("id", reminder.id);
        cancelled += 1;
        continue;
      }

      const contactRelation = appointment.contacts as
        | WhatsAppContact
        | WhatsAppContact[]
        | null;
      const professionalRelation = appointment.professionals as
        | { name?: string }
        | Array<{ name?: string }>
        | null;
      const contact = Array.isArray(contactRelation)
        ? contactRelation[0]
        : contactRelation;
      const professional = Array.isArray(professionalRelation)
        ? professionalRelation[0]
        : professionalRelation;
      if (!contact) throw new Error("CONTACT_NOT_FOUND");
      if (!hasActiveWhatsAppConsent(contact)) {
        throw new WhatsAppPolicyError("UTILITY_CONSENT_REQUIRED");
      }

      const templateKey = reminderTemplateKey(reminder.type);
      const { data: template, error: templateError } = await client
        .from("message_templates")
        .select(
          "key,meta_name,language_code,body_preview,enabled,category,meta_status",
        )
        .eq("key", templateKey)
        .single();
      if (templateError || !template?.enabled) {
        throw new WhatsAppPolicyError("TEMPLATE_UNAVAILABLE");
      }
      if (
        (template.meta_status as string | null)?.toUpperCase() !== "APPROVED"
      ) {
        throw new WhatsAppPolicyError("TEMPLATE_NOT_APPROVED");
      }
      if ((template.category as string | null)?.toUpperCase() !== "UTILITY") {
        throw new WhatsAppPolicyError("TEMPLATE_NOT_UTILITY");
      }

      const { data: conversationResult, error: conversationError } =
        await client.rpc("get_or_create_open_conversation", {
          p_contact_id: appointment.contact_id,
        });
      if (conversationError || !conversationResult) {
        throw new Error("CONVERSATION_NOT_FOUND");
      }
      const conversation = Array.isArray(conversationResult)
        ? conversationResult[0]
        : conversationResult;
      const params = [
        contact.name,
        formatAppointmentDate(startsAt, businessTimezone),
        formatAppointmentTime(startsAt, businessTimezone),
        professional?.name ?? "Gisela Lentz",
      ];
      const payload = templatePayload(
        template.meta_name as string,
        template.language_code as string,
        params,
      ) as {
        type: string;
        template: { components?: Array<Record<string, unknown>> };
      };
      payload.template.components = [
        ...(payload.template.components ?? []),
        {
          type: "button",
          sub_type: "quick_reply",
          index: "0",
          parameters: [
            { type: "payload", payload: `reminder:confirm:${appointment.id}` },
          ],
        },
        {
          type: "button",
          sub_type: "quick_reply",
          index: "1",
          parameters: [
            {
              type: "payload",
              payload: `reminder:reschedule:${appointment.id}`,
            },
          ],
        },
        {
          type: "button",
          sub_type: "quick_reply",
          index: "2",
          parameters: [
            { type: "payload", payload: `reminder:cancel:${appointment.id}` },
          ],
        },
      ];

      const message = await sendAndRecordMessage({
        client,
        conversation: conversation as WhatsAppConversation,
        contact,
        payload: payload as unknown as Record<string, unknown>,
        bodyPreview: template.body_preview as string,
        idempotencyKey: `reminder:${reminder.id}`,
        templateName: template.meta_name as string,
        templateKey,
        appointmentId: appointment.id as string,
        metadata: {
          source: "reminder",
          reminder_id: reminder.id,
          appointment_id: appointment.id,
          template_key: templateKey,
          schedule:
            reminder.type === "appointment_24h"
              ? "day_before_local_time"
              : "relative_offset",
          business_timezone: businessTimezone,
        },
      });

      if (!["sent", "delivered", "read"].includes(message.status)) {
        throw new Error(`REMINDER_MESSAGE_${message.status.toUpperCase()}`);
      }

      await client
        .from("reminders")
        .update({
          status: "sent",
          message_id: message.id,
          sent_at: new Date().toISOString(),
          processing_started_at: null,
          last_error: null,
        })
        .eq("id", reminder.id);
      sent += 1;
    } catch (error) {
      const message = safeErrorMessage(error);
      const policyBlocked = isWhatsAppPolicyError(error);
      const retryable = shouldRetryWhatsAppError(error);
      await client
        .from("reminders")
        .update({
          status: policyBlocked
            ? "cancelled"
            : retryable && reminder.attempts < 3
              ? "pending"
              : "failed",
          processing_started_at: null,
          last_error: message,
        })
        .eq("id", reminder.id);
      console.error("process-reminders", reminder.id, message);
      if (policyBlocked) cancelled += 1;
      else failed += 1;
    }
  }

  return jsonResponse(request, {
    expired_holds: expiredHolds,
    expired_notifications_sent: expiredNotificationsSent,
    expired_notifications_failed: expiredNotificationsFailed,
    expired_notifications_cancelled: expiredNotificationsCancelled,
    queued_tomorrow: Number.isFinite(queuedTomorrow) ? queuedTomorrow : 0,
    already_queued_tomorrow: Number.isFinite(alreadyQueuedTomorrow)
      ? alreadyQueuedTomorrow
      : 0,
    claimed: (claimed ?? []).length,
    sent,
    failed,
    cancelled,
  });
});
