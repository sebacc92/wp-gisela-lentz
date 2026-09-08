import { processOwnerDailySummary } from "./owner-daily-summary.ts";
import {
  jsonResponse,
  optionsResponse,
  safeErrorMessage,
} from "../_shared/http.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import {
  DEFAULT_BUSINESS_TIMEZONE,
  hasActiveWhatsAppConsent,
  sendAndRecordMessage,
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
import {
  classifyReminderWhatsAppFailure,
  deliverAppointmentReminder,
  updateClaimedReminder,
} from "./reminder-delivery.ts";

interface ReminderRow {
  id: string;
  appointment_id: string;
  type: ReminderType;
  attempts: number;
  processing_started_at: string;
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

  // Independiente de las plantillas y del consentimiento para avisos a pacientes.
  // Una falla del resumen privado no interrumpe expiraciones ni otros avisos.
  const ownerSummary = await processOwnerDailySummary({ client }).catch(() => {
    console.error("process-reminders", "OWNER_SUMMARY_FAILED");
    return { status: "failed", reason: "OWNER_SUMMARY_FAILED", recipients: [] };
  });

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
        const failure = classifyReminderWhatsAppFailure(error, {
          retryUnknown: true,
        });
        // Las fallas locales/DB también pueden ser transitorias. El RPC limita
        // los intentos a tres; políticas y estados de cuenta son terminales.
        const errorCode = failure.policyBlocked
          ? `WHATSAPP_POLICY:${
              error instanceof WhatsAppPolicyError
                ? error.code
                : "POLICY_BLOCKED"
            }`
          : failure.credentialTerminal
            ? "WHATSAPP_CREDENTIAL_TERMINAL"
            : failure.retryable
              ? "SEND_RETRYABLE"
              : "SEND_FAILED";
        await client.rpc("fail_expired_booking_hold_notification", {
          p_appointment_id: claim.appointment_id,
          p_error_code: errorCode,
          p_retryable: failure.retryable,
        });
        if (failure.policyBlocked) expiredNotificationsCancelled += 1;
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
          "id,contact_id,starts_at,status,contacts!appointments_contact_id_fkey(id,phone_e164,whatsapp_id,whatsapp_user_id,name,whatsapp_opt_in_at,whatsapp_opt_out_at,whatsapp_consent_status)",
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
        const updated = await updateClaimedReminder(
          client,
          {
            id: reminder.id,
            processingStartedAt: reminder.processing_started_at,
          },
          {
            status: "cancelled",
            processing_started_at: null,
            last_error: "APPOINTMENT_NOT_ACTIVE",
          },
        );
        if (updated) cancelled += 1;
        continue;
      }

      const startsAt = appointment.starts_at as string;
      if (
        reminder.type === "appointment_24h" &&
        !isAppointmentTomorrow(startsAt, new Date(), businessTimezone)
      ) {
        const updated = await updateClaimedReminder(
          client,
          {
            id: reminder.id,
            processingStartedAt: reminder.processing_started_at,
          },
          {
            status: "cancelled",
            processing_started_at: null,
            last_error: "REMINDER_WINDOW_EXPIRED",
          },
        );
        if (updated) cancelled += 1;
        continue;
      }

      const contactRelation = appointment.contacts as
        | WhatsAppContact
        | WhatsAppContact[]
        | null;
      const contact = Array.isArray(contactRelation)
        ? contactRelation[0]
        : contactRelation;
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
      const message = await deliverAppointmentReminder({
        client,
        conversation: conversation as WhatsAppConversation,
        contact,
        reminder,
        appointment: {
          id: appointment.id as string,
          starts_at: startsAt,
        },
        template: {
          key: templateKey,
          meta_name: template.meta_name as string,
          language_code: template.language_code as string,
          body_preview: template.body_preview as string,
        },
        businessTimezone,
      });

      if (!["sent", "delivered", "read"].includes(message.status)) {
        throw new Error(`REMINDER_MESSAGE_${message.status.toUpperCase()}`);
      }

      const updated = await updateClaimedReminder(
        client,
        {
          id: reminder.id,
          processingStartedAt: reminder.processing_started_at,
        },
        {
          status: "sent",
          message_id: message.id,
          sent_at: new Date().toISOString(),
          processing_started_at: null,
          last_error: null,
        },
      );
      if (updated) sent += 1;
    } catch (error) {
      const message = safeErrorMessage(error);
      const failure = classifyReminderWhatsAppFailure(error, {
        retryUnknown: false,
      });
      const updated = await updateClaimedReminder(
        client,
        {
          id: reminder.id,
          processingStartedAt: reminder.processing_started_at,
        },
        {
          status: failure.policyBlocked
            ? "cancelled"
            : failure.retryable && reminder.attempts < 3
              ? "pending"
              : "failed",
          processing_started_at: null,
          last_error: message,
        },
      );
      console.error("process-reminders", reminder.id, message);
      if (updated) {
        if (failure.policyBlocked) cancelled += 1;
        else failed += 1;
      }
    }
  }

  return jsonResponse(request, {
    owner_summary: ownerSummary,
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
