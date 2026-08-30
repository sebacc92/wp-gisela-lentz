import type { SupabaseClient } from "npm:@supabase/supabase-js@2.112.2";

import { isWhatsAppCredentialResolutionError } from "../_shared/whatsapp-account-credentials.ts";
import {
  formatAppointmentDate,
  formatAppointmentTime,
  sendAndRecordMessage,
  isWhatsAppPolicyError,
  shouldRetryWhatsAppError,
  templatePayload,
  type RecordedMessage,
  type WhatsAppContact,
  type WhatsAppConversation,
} from "../_shared/whatsapp.ts";
import type { ReminderType } from "./reminder-schedule.ts";

export interface ClaimedReminderIdentity {
  id: string;
  processingStartedAt: string;
}

/**
 * Finalize only the exact claim returned by claim_due_reminders. Account
 * offboarding clears processing_started_at while cancelling pending work, and
 * stale-claim recovery replaces it. Matching both status and timestamp keeps
 * an older worker from reopening either transition.
 */
export async function updateClaimedReminder(
  client: SupabaseClient,
  claim: ClaimedReminderIdentity,
  values: Record<string, unknown>,
): Promise<boolean> {
  if (
    !claim.id ||
    !claim.processingStartedAt ||
    !Number.isFinite(Date.parse(claim.processingStartedAt))
  ) {
    throw new Error("REMINDER_CLAIM_INVALID");
  }
  const result = await client
    .from("reminders")
    .update(values)
    .eq("id", claim.id)
    .eq("status", "processing")
    .eq("processing_started_at", claim.processingStartedAt)
    .select("id")
    .maybeSingle();
  if (result.error) throw new Error("REMINDER_CLAIM_UPDATE_FAILED");
  return result.data?.id === claim.id;
}

export function classifyReminderWhatsAppFailure(
  error: unknown,
  options: { retryUnknown: boolean },
): {
  policyBlocked: boolean;
  credentialTerminal: boolean;
  retryable: boolean;
} {
  const policyBlocked = isWhatsAppPolicyError(error);
  const credentialError = isWhatsAppCredentialResolutionError(error)
    ? error
    : null;
  const credentialTerminal =
    credentialError !== null && !credentialError.retryable;
  return {
    policyBlocked,
    credentialTerminal,
    retryable:
      !policyBlocked &&
      !credentialTerminal &&
      (credentialError?.retryable === true ||
        options.retryUnknown ||
        shouldRetryWhatsAppError(error)),
  };
}

export async function deliverAppointmentReminder(input: {
  client: SupabaseClient;
  reminder: { id: string; type: ReminderType };
  appointment: { id: string; starts_at: string };
  conversation: WhatsAppConversation;
  contact: WhatsAppContact;
  template: {
    key: string;
    meta_name: string;
    language_code: string;
    body_preview: string;
  };
  businessTimezone: string;
  fetchImpl?: typeof fetch;
}): Promise<RecordedMessage> {
  const params = [
    input.contact.name,
    formatAppointmentDate(input.appointment.starts_at, input.businessTimezone),
    formatAppointmentTime(input.appointment.starts_at, input.businessTimezone),
  ];
  const payload = templatePayload(
    input.template.meta_name,
    input.template.language_code,
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
        {
          type: "payload",
          payload: `reminder:confirm:${input.appointment.id}`,
        },
      ],
    },
    {
      type: "button",
      sub_type: "quick_reply",
      index: "1",
      parameters: [
        {
          type: "payload",
          payload: `reminder:reschedule:${input.appointment.id}`,
        },
      ],
    },
    {
      type: "button",
      sub_type: "quick_reply",
      index: "2",
      parameters: [
        {
          type: "payload",
          payload: `reminder:cancel:${input.appointment.id}`,
        },
      ],
    },
  ];

  return await sendAndRecordMessage({
    client: input.client,
    conversation: input.conversation,
    contact: input.contact,
    payload: payload as unknown as Record<string, unknown>,
    bodyPreview: input.template.body_preview,
    idempotencyKey: `reminder:${input.reminder.id}`,
    templateName: input.template.meta_name,
    templateKey: input.template.key,
    appointmentId: input.appointment.id,
    metadata: {
      source: "reminder",
      reminder_id: input.reminder.id,
      appointment_id: input.appointment.id,
      template_key: input.template.key,
      schedule:
        input.reminder.type === "appointment_24h"
          ? "day_before_local_time"
          : "relative_offset",
      business_timezone: input.businessTimezone,
    },
    fetchImpl: input.fetchImpl,
  });
}
