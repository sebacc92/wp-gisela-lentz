import {
  PATIENT_PROFILE_PROMPTS,
  MAIN_MENU_OPTIONS,
  MAX_SLOTS_OFFERED_PER_DAY,
  asksAboutPrice,
  depositProofReviewMessage,
  formatDepositAmountArs,
  isConversationAcknowledgement,
  isConversationGreeting,
  isOtherCoverageReply,
  isMainMenuRequest,
  missingPatientProfileFields,
  nextInvalidAttempt,
  normalizeUserInput,
  parseAppointmentSelection,
  parsePatientProfileReply,
  parseServiceReply,
  parseSlotSelection,
  renderConfiguredMessage,
  selectSlotsForOffer,
  resolveAppointmentConfirmation,
  resolveCancellationConfirmation,
  resolveMainMenuIntent,
  resolveRescheduleConfirmation,
  resolveRescheduleRequest,
  requestsMultipleAppointments,
  type MainMenuIntent,
  type PatientCoverage,
  type PatientProfileField,
} from "../_shared/automation-flow.ts";
import {
  isSecretaryRequest,
  resolveTypedServiceOption,
  SECRETARY_HANDOFF_MESSAGE,
  SECRETARY_REPLY_ID,
  withSecretaryMenuOption,
} from "./flow-options.ts";
import {
  whatsappConversationOperationallyEnabled,
  type WhatsAppAutomationExecutionLease,
} from "../_shared/app-automations.ts";
import {
  conciseBusinessLocationMessage,
  configuredBusinessHoursMessage,
  INFORMATION_FOLLOW_UP_BUTTONS,
  informationFlowResumePrompt,
  informationFlowSessionTarget,
  resolveBusinessLocation,
} from "../_shared/business-location.ts";
import { validateDepositProofForAutoConfirmation } from "../_shared/deposit-proof.ts";
import {
  jsonResponse,
  optionsResponse,
  safeErrorMessage,
} from "../_shared/http.ts";
import {
  requiresHumanReview,
  requiresPriority,
  whatsappConsentDecisionFromText,
  type NormalizedIncomingMessage,
} from "../_shared/incoming-message.ts";
import {
  administrativeInfoIntent,
  administrativeInfoRoute,
  administrativeOpenAIEnabled,
  administrativeSafetyIdentifier,
  buildAdministrativeKnowledge,
  formatStructuredBusinessHours,
  isAllowedAdministrativeQuestion,
  OPENAI_ADMINISTRATIVE_HANDOFF_MESSAGE,
  requestAdministrativeOpenAIAnswer,
  resolveDurableAdministrativeAnswer,
} from "../_shared/openai-administrative.ts";
import { downloadInboundWhatsAppMedia } from "../_shared/whatsapp-media-download.ts";
import { whatsappMediaMaxBytes } from "../_shared/whatsapp-media.ts";
import {
  mediaOpenAIEnabled,
  mediaSha256Hex,
  requestAudioTranscription,
  requestDepositProofReading,
  type AudioTranscription,
  type DepositProofReading,
} from "../_shared/openai-media.ts";
import {
  OWNER_HELP_MESSAGE,
  detectOwnerRequest,
  formatOwnerAgenda,
  formatOwnerPatient,
  isOwnerNumber,
  ownerNumbersFromEnvironment,
  type OwnerAgendaAppointment,
} from "../_shared/owner-access.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { constantTimeEqual } from "../_shared/whatsapp-webhook.ts";
import {
  buttonsPayload,
  DEFAULT_BUSINESS_TIMEZONE,
  formatAppointmentDate,
  formatAppointmentTime,
  isWhatsAppTestRecipientAllowed,
  isRetryableWhatsAppAutomationFailure,
  isWhatsAppPolicyError,
  listPayload,
  locationPayload,
  sendAndRecordMessage,
  WhatsAppPolicyError,
  textPayload,
  type WhatsAppContact,
  type WhatsAppConversation,
  whatsAppPolicyCode,
  whatsappAutomationsEnabled,
} from "../_shared/whatsapp.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.112.2";

interface AutomationInput {
  messageId: string;
}

const APPOINTMENT_MAIN_MENU_OPTIONS =
  withSecretaryMenuOption(MAIN_MENU_OPTIONS);

interface InboundSnapshot {
  id: string;
  conversation_id: string;
  contact_id: string;
  coexistence_account_id: string | null;
  body: string | null;
  type: "text" | "interactive" | "image" | "document" | "audio";
  direction: "inbound";
  metadata: Record<string, unknown> | null;
}

interface ConversationSnapshot {
  id: string;
  contact_id: string;
  coexistence_account_id?: string | null;
  last_inbound_message_at: string | null;
  automation_mode: "auto" | "manual";
  needs_human: boolean;
  priority: boolean;
}

interface ContactSnapshot {
  id: string;
  phone_e164: string | null;
  whatsapp_id: string | null;
  whatsapp_user_id: string | null;
  name: string;
  coverage: PatientCoverage | null;
  is_existing_patient: boolean | null;
  alternate_phone_e164: string | null;
}

interface AppSettingsSnapshot {
  automations_enabled?: boolean;
  automation_welcome_message?: string | null;
  urgent_message?: string | null;
  general_info_message?: string | null;
  business_address?: string | null;
  business_location_name?: string | null;
  business_location_address?: string | null;
  business_latitude?: number | null;
  business_longitude?: number | null;
  business_maps_url?: string | null;
  ai_enabled?: boolean;
  ai_media_enabled?: boolean;
  ai_model?: string | null;
  out_of_hours_enabled?: boolean;
  out_of_hours_message?: string | null;
  out_of_hours_cooldown_minutes?: number;
  timezone?: string | null;
  deposit_amount_ars?: number;
  deposit_alias?: string | null;
  deposit_holder?: string | null;
  booking_hold_minutes?: number;
  deposit_request_message_template?: string | null;
  deposit_proof_received_message_template?: string | null;
  deposit_confirmed_message_template?: string | null;
}

type DurableMediaUnderstanding =
  | { kind: "audio"; transcription: AudioTranscription }
  | {
      kind: "deposit_proof";
      reading: DepositProofReading;
      mediaSha256: string;
    };

type DepositProofMediaFailureReason =
  | "MEDIA_DISABLED"
  | "DOWNLOAD_FAILED"
  | "READING_FAILED"
  | "UNREADABLE";

interface AutomatedDepositProofResult {
  status: "confirmed" | "already_confirmed" | "review" | "late" | "superseded";
  appointmentId: string;
  startsAt: string;
  originalStatus: "confirmed" | "review" | "late" | null;
  confirmationActor: "automatic_system" | "human_operator" | null;
  reviewReasons: string[];
}

function normalizeAutomatedDepositProofResult(
  value: unknown,
): AutomatedDepositProofResult | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (!candidate || typeof candidate !== "object") return null;
  const row = candidate as Record<string, unknown>;
  if (
    ![
      "confirmed",
      "already_confirmed",
      "review",
      "late",
      "superseded",
    ].includes(String(row.status)) ||
    typeof row.appointment_id !== "string" ||
    !UUID_PATTERN.test(row.appointment_id) ||
    typeof row.starts_at !== "string" ||
    !Number.isFinite(new Date(row.starts_at).getTime())
  ) {
    return null;
  }
  return {
    status: row.status as AutomatedDepositProofResult["status"],
    appointmentId: row.appointment_id,
    startsAt: row.starts_at,
    originalStatus: ["confirmed", "review", "late"].includes(
      String(row.original_status),
    )
      ? (row.original_status as "confirmed" | "review" | "late")
      : null,
    confirmationActor:
      row.confirmation_actor === "automatic_system" ||
      row.confirmation_actor === "human_operator"
        ? row.confirmation_actor
        : null,
    reviewReasons: Array.isArray(row.review_reasons)
      ? row.review_reasons
          .filter(
            (reason): reason is string =>
              typeof reason === "string" && reason.trim().length > 0,
          )
          .map((reason) => reason.trim())
          .slice(0, 16)
      : typeof row.reason === "string" && row.reason.trim()
        ? [row.reason.trim()]
        : [],
  };
}

function isDepositProofReviewableRpcError(error: unknown): boolean {
  const message =
    error && typeof error === "object" && "message" in error
      ? String((error as { message?: unknown }).message ?? "")
      : error instanceof Error
        ? error.message
        : "";
  const normalized = message.toUpperCase();
  return [
    "AUTOMATED_DEPOSIT_PROOF_INVALID",
    "AUTOMATED_DEPOSIT_REVIEW_ROUTE_INVALID",
    "AUTOMATED_DEPOSIT_PROOF_POLICY_UNSUPPORTED",
    "AUTOMATED_DEPOSIT_PROOF_REQUEST_CONFLICT",
    "APPOINTMENT_NOT_FOUND",
    "APP_SETTINGS_NOT_FOUND",
    "DEPOSIT_PROOF_MESSAGE_NOT_FOUND",
    "DEPOSIT_PROOF_MESSAGE_INVALID",
    "DEPOSIT_PROOF_CONTEXT_MISMATCH",
    "DEPOSIT_PROOF_PREDATES_HOLD",
    "DEPOSIT_PROOF_MEDIA_HASH_MISMATCH",
    "DEPOSIT_PROOF_READING_MISMATCH",
    "DEPOSIT_PROOF_ROUTE_REASON_MISMATCH",
    "DEPOSIT_PROOF_APPOINTMENT_METADATA_MISMATCH",
    "DEPOSIT_PROOF_ALREADY_USED",
    "APPOINTMENT_PROOF_MESSAGE_CONFLICT",
    "APPOINTMENT_DEPOSIT_STATE_INVALID",
    "APPOINTMENT_DEPOSIT_HOLD_INVALID",
    "APPOINTMENT_DEPOSIT_EXPECTATION_MISSING",
    "WHATSAPP_AUTOMATION_DEPOSIT_EFFECT_CONTEXT_MISMATCH",
    "WHATSAPP_AUTOMATION_EFFECT_CONFLICT",
  ].some((code) => normalized.includes(code));
}

function normalizeDurableMediaUnderstanding(
  value: unknown,
): DurableMediaUnderstanding | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === "audio") {
    const transcription = candidate.transcription as
      | Record<string, unknown>
      | undefined;
    if (
      !transcription ||
      typeof transcription.transcript !== "string" ||
      typeof transcription.audible !== "boolean"
    ) {
      return null;
    }
    return {
      kind: "audio",
      transcription: {
        transcript: transcription.transcript.slice(0, 4000),
        audible: transcription.audible,
      },
    };
  }
  if (candidate.kind !== "deposit_proof") return null;
  const reading = candidate.reading as Record<string, unknown> | undefined;
  if (
    !reading ||
    typeof reading.legible !== "boolean" ||
    typeof candidate.mediaSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(candidate.mediaSha256)
  ) {
    return null;
  }
  const optionalText = (field: string, maxLength: number) => {
    const fieldValue = reading[field];
    return typeof fieldValue === "string"
      ? fieldValue.trim().slice(0, maxLength) || null
      : null;
  };
  return {
    kind: "deposit_proof",
    mediaSha256: candidate.mediaSha256,
    reading: {
      legible: reading.legible,
      amount:
        typeof reading.amount === "number" && Number.isFinite(reading.amount)
          ? reading.amount
          : null,
      currency: optionalText("currency", 32),
      date: optionalText("date", 10),
      destination: optionalText("destination", 120),
      holder: optionalText("holder", 120),
      operationId: optionalText("operationId", 160),
    },
  };
}

interface AutomationExecutionClaim {
  disposition: "claimed" | "busy" | "completed" | "terminal";
  lease_token: string | null;
  attempts: number;
  snapshot_at: string;
  message_snapshot: InboundSnapshot;
  conversation_snapshot: ConversationSnapshot;
  contact_snapshot: ContactSnapshot;
  settings_snapshot: AppSettingsSnapshot;
  session_state: string;
  session_context: AutomationContext;
  session_expires_at: string | null;
  fresh_session: boolean;
  outcome: Record<string, unknown> | null;
}

type AutomationExecutionLease = WhatsAppAutomationExecutionLease;

interface CommittedAutomationDomainEffect {
  conversationId: string;
  appointmentId: string;
  type: "create" | "reschedule" | "cancel" | "deposit_confirm";
}

async function completeExecution(
  client: SupabaseClient,
  lease: AutomationExecutionLease,
  outcome: Record<string, unknown>,
): Promise<void> {
  const result = await client.rpc("complete_whatsapp_automation_execution", {
    p_message_id: lease.messageId,
    p_lease_token: lease.leaseToken,
    p_outcome: outcome,
  });
  if (result.error || result.data !== true) {
    throw new Error(
      `AUTOMATION_EXECUTION_COMPLETION_FAILED:${result.error?.message ?? "LEASE_LOST"}`,
    );
  }
}

async function failExecution(
  client: SupabaseClient,
  lease: AutomationExecutionLease,
  error: unknown,
): Promise<void> {
  const result = await client.rpc("fail_whatsapp_automation_execution", {
    p_message_id: lease.messageId,
    p_lease_token: lease.leaseToken,
    p_error: safeErrorMessage(error),
    p_retryable: isRetryableWhatsAppAutomationFailure(error),
  });
  if (result.error || result.data !== true) {
    console.error("whatsapp-automation execution failure not persisted", {
      messageId: lease.messageId,
      code: result.error?.message ?? "LEASE_LOST",
    });
  }
}

async function handoffCommittedExecution(
  client: SupabaseClient,
  lease: AutomationExecutionLease,
  effect: CommittedAutomationDomainEffect,
  reason: string,
): Promise<Record<string, unknown>> {
  await claimInboundHandoff(client, lease.messageId);
  const result = await client.rpc("handoff_whatsapp_automation_execution", {
    p_message_id: lease.messageId,
    p_lease_token: lease.leaseToken,
    p_reason: reason,
    p_appointment_id: effect.appointmentId,
  });
  if (result.error || !result.data || Array.isArray(result.data)) {
    throw new Error(
      `AUTOMATION_HANDOFF_FAILED:${result.error?.message ?? "EMPTY_RESULT"}`,
    );
  }
  return result.data as Record<string, unknown>;
}

async function claimInboundHandoff(
  client: SupabaseClient,
  messageId: string,
  priority = false,
  currentFlow: string | null = null,
): Promise<void> {
  const result = await client.rpc(
    "pause_whatsapp_automation_for_inbound_handoff",
    {
      p_message_id: messageId,
      p_priority: priority,
      p_current_flow: currentFlow,
    },
  );
  if (result.error) throw result.error;
  if (result.data !== true) {
    throw new WhatsAppPolicyError("AUTOMATION_PAUSED");
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface AutomationSlot {
  startsAt: string;
  endsAt: string;
  professionalId: string;
  professionalName: string;
  serviceId: string;
  serviceName: string;
}

interface AutomationContext {
  invalidAttempts?: number;
  professionalId?: string;
  professionalName?: string;
  professionalPage?: number;
  serviceId?: string;
  serviceName?: string;
  appointmentId?: string;
  slots?: AutomationSlot[];
  expectedProfileField?: PatientProfileField;
  contactPhoneConfirmed?: boolean;
  continueAfterProfile?: "services" | "reschedule";
  depositHelpShown?: boolean;
  depositAcknowledged?: boolean;
}

interface Session {
  state: string;
  context: AutomationContext;
  expires_at: string | null;
}

interface AppointmentSummary {
  id: string;
  professionalId: string;
  professionalName: string;
  serviceId: string;
  serviceName: string;
  startsAt: string;
  status: "scheduled" | "confirmed";
  depositStatus:
    | "not_required"
    | "pending"
    | "proof_received"
    | "confirmed"
    | "expired";
  holdExpiresAt: string | null;
}

function dateInTimezone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone,
  }).formatToParts(date);
  const value = (type: string) =>
    parts.find((part) => part.type === type)?.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function compactAppointmentDate(value: string, timeZone: string): string {
  return new Intl.DateTimeFormat("es-AR", {
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    timeZone,
  })
    .format(new Date(value))
    .replace(",", "");
}

function appointmentRelationName(
  relation: { name?: string } | Array<{ name?: string }> | null,
): string {
  const professional = Array.isArray(relation) ? relation[0] : relation;
  return professional?.name ?? "Gisela Lentz";
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return optionsResponse(request);
  if (request.method !== "POST") {
    return jsonResponse(request, { error: "METHOD_NOT_ALLOWED" }, 405);
  }

  const expectedSecret = Deno.env.get("AUTOMATION_INTERNAL_SECRET")?.trim();
  const providedSecret = request.headers.get("x-internal-secret")?.trim() ?? "";
  if (!expectedSecret || !constantTimeEqual(providedSecret, expectedSecret)) {
    return jsonResponse(request, { error: "UNAUTHORIZED" }, 401);
  }
  const client = createServiceClient();
  let executionLease: AutomationExecutionLease | null = null;
  let sessionWriteSequence = 0;
  let committedDomainEffect: CommittedAutomationDomainEffect | null = null;

  try {
    const rawInput: unknown = await request.json();
    if (
      !rawInput ||
      typeof rawInput !== "object" ||
      Array.isArray(rawInput) ||
      Object.keys(rawInput).some((key) => key !== "messageId")
    ) {
      return jsonResponse(request, { error: "INVALID_REQUEST" }, 400);
    }
    const input = rawInput as Partial<AutomationInput>;
    if (
      typeof input.messageId !== "string" ||
      !UUID_PATTERN.test(input.messageId)
    ) {
      return jsonResponse(request, { error: "INVALID_REQUEST" }, 400);
    }

    const { data: inboundLookup, error: messageError } = await client
      .from("messages")
      .select(
        "id,conversation_id,contact_id,coexistence_account_id,body,type,direction,metadata",
      )
      .eq("id", input.messageId)
      .single();
    if (messageError && messageError.code !== "PGRST116") {
      throw new Error(
        `AUTOMATION_MESSAGE_LOOKUP_FAILED:${messageError.message}`,
      );
    }
    if (!inboundLookup || inboundLookup.direction !== "inbound") {
      return jsonResponse(request, { ignored: true });
    }

    const claimResult = await client.rpc(
      "claim_whatsapp_automation_execution",
      {
        p_message_id: input.messageId,
        p_request_snapshot: {
          delivery_mode: "whatsapp",
        },
        p_stale_after_seconds: 900,
      },
    );
    const execution = (
      Array.isArray(claimResult.data) ? claimResult.data[0] : claimResult.data
    ) as AutomationExecutionClaim | null;
    if (claimResult.error || !execution) {
      throw new Error(
        `AUTOMATION_EXECUTION_CLAIM_FAILED:${claimResult.error?.message ?? "EMPTY_RESULT"}`,
      );
    }
    if (execution.disposition === "completed") {
      return jsonResponse(request, {
        ...(execution.outcome ?? { processed: true }),
        deduplicated: true,
      });
    }
    if (execution.disposition === "busy") {
      return jsonResponse(request, { error: "AUTOMATION_EXECUTION_BUSY" }, 409);
    }
    if (execution.disposition !== "claimed" || !execution.lease_token) {
      return jsonResponse(
        request,
        { error: "AUTOMATION_EXECUTION_TERMINAL" },
        500,
      );
    }

    executionLease = {
      messageId: input.messageId,
      leaseToken: execution.lease_token,
    };
    const finish = async (outcome: Record<string, unknown>) => {
      if (!executionLease) throw new Error("AUTOMATION_EXECUTION_LEASE_LOST");
      await completeExecution(client, executionLease, outcome);
      executionLease = null;
      return jsonResponse(request, outcome);
    };

    const inbound = execution.message_snapshot;
    const conversation = execution.conversation_snapshot;
    const contact = execution.contact_snapshot;
    const appSettings = execution.settings_snapshot;

    // The live database decision is global OR the conversation's unexpired
    // test override. The environment kill switch is checked independently
    // below and again at the final Graph gate.
    if (
      !(await whatsappConversationOperationallyEnabled({
        client,
        conversationId: conversation.id,
      }))
    ) {
      return await finish({ ignored: true, reason: "AUTOMATIONS_DISABLED" });
    }
    const executionNow = new Date(execution.snapshot_at);
    if (!Number.isFinite(executionNow.getTime())) {
      throw new Error("AUTOMATION_EXECUTION_SNAPSHOT_INVALID");
    }
    const priorEffectResult = await client
      .from("whatsapp_automation_effects")
      .select("effect_type,appointment_id,result")
      .eq("execution_message_id", inbound.id)
      .in("effect_type", [
        "appointment_create",
        "appointment_reschedule",
        "appointment_cancel",
        "appointment_deposit_process",
      ])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (priorEffectResult.error) throw priorEffectResult.error;
    const priorEffect = priorEffectResult.data as {
      effect_type: string;
      appointment_id: string | null;
      result: Record<string, unknown>;
    } | null;
    const priorDepositProofResult =
      priorEffect?.effect_type === "appointment_deposit_process" &&
      priorEffect.result?.effect_status === "applied"
        ? normalizeAutomatedDepositProofResult(priorEffect.result)
        : null;
    if (
      priorEffect?.appointment_id &&
      priorEffect.result?.effect_status !== "rejected" &&
      (priorEffect.effect_type !== "appointment_deposit_process" ||
        priorEffect.result?.status === "confirmed")
    ) {
      const type =
        priorEffect.effect_type === "appointment_create"
          ? "create"
          : priorEffect.effect_type === "appointment_reschedule"
            ? "reschedule"
            : priorEffect.effect_type === "appointment_cancel"
              ? "cancel"
              : "deposit_confirm";
      committedDomainEffect = {
        conversationId: conversation.id,
        appointmentId: priorEffect.appointment_id,
        type,
      };
    }

    const finishCommittedEffectWithHandoff = async (
      reason: string,
    ): Promise<Response | null> => {
      const domainEffect = committedDomainEffect;
      const lease = executionLease;
      if (!domainEffect || !lease) return null;
      const outcome = await handoffCommittedExecution(
        client,
        lease,
        domainEffect,
        reason,
      );
      return await finish(outcome);
    };

    if (!whatsappAutomationsEnabled()) {
      const handoff = await finishCommittedEffectWithHandoff(
        "POST_DOMAIN_AUTOMATIONS_DISABLED",
      );
      if (handoff) return handoff;
      return await finish({
        processed: false,
        ignored: true,
        reason: "AUTOMATIONS_DISABLED",
      });
    }
    const automationRecipient =
      typeof contact.whatsapp_user_id === "string" &&
      contact.whatsapp_user_id.trim()
        ? contact.whatsapp_user_id
        : typeof contact.whatsapp_id === "string" && contact.whatsapp_id.trim()
          ? contact.whatsapp_id
          : (contact.phone_e164 ?? "");
    if (
      !isWhatsAppTestRecipientAllowed(
        automationRecipient,
        Deno.env.get("WHATSAPP_TEST_MODE"),
        Deno.env.get("WHATSAPP_TEST_ALLOWED_NUMBERS"),
      )
    ) {
      console.warn("whatsapp-automation", "TEST_RECIPIENT_NOT_ALLOWED");
      const handoff = await finishCommittedEffectWithHandoff(
        "POST_DOMAIN_TEST_RECIPIENT_NOT_ALLOWED",
      );
      if (handoff) return handoff;
      return await finish({
        processed: false,
        ignored: true,
        reason: "TEST_RECIPIENT_NOT_ALLOWED",
      });
    }

    const freshSession = execution.fresh_session;
    const session: Session = {
      state: execution.session_state,
      context: execution.session_context ?? {},
      expires_at: execution.session_expires_at,
    };
    const metadata = (inbound.metadata ?? {}) as Record<string, unknown>;
    const replyId =
      typeof metadata.interactive_reply_id === "string"
        ? metadata.interactive_reply_id
        : "";
    let inboundBody = typeof inbound.body === "string" ? inbound.body : "";
    let mediaUnderstanding: DurableMediaUnderstanding | null = null;
    let unreadableMedia = false;
    let transcribedAudioPriority = false;
    let transcribedAudioNeedsHuman = false;
    let normalizedInboundBody = "";
    let inputValue = replyId || inboundBody;

    const configuredWelcomeMessage =
      typeof appSettings?.automation_welcome_message === "string"
        ? appSettings.automation_welcome_message.trim()
        : "";
    const welcomeMessage = configuredWelcomeMessage || undefined;
    const businessTimezone =
      typeof appSettings?.timezone === "string" && appSettings.timezone.trim()
        ? appSettings.timezone.trim()
        : DEFAULT_BUSINESS_TIMEZONE;
    const formatDate = (value: string) =>
      formatAppointmentDate(value, businessTimezone);
    const formatTime = (value: string) =>
      formatAppointmentTime(value, businessTimezone);
    const compactDate = (value: string) =>
      compactAppointmentDate(value, businessTimezone);
    const slotOptionLabel = (slot: AutomationSlot) =>
      `${compactDate(slot.startsAt)} · ${formatTime(slot.startsAt)}`;

    sessionWriteSequence = 0;
    const saveSessionAt = async (
      state: string,
      context: AutomationContext,
      expiresAt: string | null,
    ) => {
      const lease = executionLease;
      if (!lease) throw new Error("AUTOMATION_EXECUTION_LEASE_LOST");
      const sequence = sessionWriteSequence;
      sessionWriteSequence += 1;
      const result = await client.rpc("save_whatsapp_automation_session", {
        p_message_id: lease.messageId,
        p_lease_token: lease.leaseToken,
        p_sequence: sequence,
        p_state: state,
        p_context: context,
        p_expires_at: expiresAt,
      });
      if (result.error) throw result.error;
    };
    const saveSession = async (
      state: string,
      context: AutomationContext = {},
      ttlMinutes = 30,
    ) =>
      await saveSessionAt(
        state,
        context,
        new Date(
          executionNow.getTime() + Math.max(1, ttlMinutes) * 60 * 1000,
        ).toISOString(),
      );

    let decisionSequence = 0;
    const durableDecision = async <T>(key: string, value: T): Promise<T> => {
      const lease = executionLease;
      if (!lease) throw new Error("AUTOMATION_EXECUTION_LEASE_LOST");
      const sequence = decisionSequence;
      decisionSequence += 1;
      const result = await client.rpc("remember_whatsapp_automation_decision", {
        p_message_id: lease.messageId,
        p_lease_token: lease.leaseToken,
        p_sequence: sequence,
        p_key: key,
        p_value: { value },
      });
      if (result.error) throw result.error;
      const remembered = result.data as { value?: T } | null;
      if (!remembered || !("value" in remembered)) {
        throw new Error("AUTOMATION_DECISION_INVALID");
      }
      return remembered.value as T;
    };

    let sendSequence = 0;
    const send = async (
      payload: Record<string, unknown>,
      bodyPreview: string,
      extraMetadata: Record<string, unknown> = {},
      source = "automation",
      appointmentId: string | null = null,
    ) => {
      const lease = executionLease;
      if (!lease) throw new Error("AUTOMATION_EXECUTION_LEASE_LOST");
      const sequence = sendSequence;
      sendSequence += 1;
      return await sendAndRecordMessage({
        client,
        conversation: conversation as WhatsAppConversation,
        contact: contact as WhatsAppContact,
        payload,
        bodyPreview,
        idempotencyKey: `automation:${inbound.id}:${sequence}`,
        appointmentId,
        coexistenceAccountId: inbound.coexistence_account_id,
        metadata: {
          ...extraMetadata,
          source,
          inbound_message_id: inbound.id,
          automation_sequence: sequence,
        },
        automationExecution: lease,
      });
    };

    const mediaMessage =
      inbound.type === "audio" ||
      inbound.type === "image" ||
      inbound.type === "document";
    const depositProofMediaMessage =
      inbound.type === "image" || inbound.type === "document";
    const snapshotAppointmentId =
      typeof session.context.appointmentId === "string" &&
      UUID_PATTERN.test(session.context.appointmentId)
        ? session.context.appointmentId
        : null;
    const depositProofMediaContextReady =
      depositProofMediaMessage &&
      session.state === "waiting_deposit" &&
      snapshotAppointmentId !== null;
    const mediaContextReady =
      inbound.type === "audio" || depositProofMediaContextReady;
    const snapshotMediaEnabled =
      mediaContextReady &&
      mediaOpenAIEnabled({
        globalAutomationsEnabled: whatsappAutomationsEnabled(),
        serverEnabled:
          Deno.env.get("OPENAI_ADMINISTRATIVE_ENABLED")?.trim() === "true",
        aiEnabled: appSettings?.ai_enabled,
        aiMediaEnabled: appSettings?.ai_media_enabled,
        model: appSettings?.ai_model,
      });

    /** Los switches del snapshot dan causalidad al intento, pero no autorizan
     * una carga después de que Gisela los apagó. Cada llamada de media vuelve a
     * leer el control vivo y cualquier error falla cerrado. */
    const readLiveMediaOpenAIEnabled = async (): Promise<boolean> => {
      const globalAutomationsEnabled = whatsappAutomationsEnabled();
      const serverEnabled =
        Deno.env.get("OPENAI_ADMINISTRATIVE_ENABLED")?.trim() === "true";
      if (!globalAutomationsEnabled || !serverEnabled) return false;

      const liveSettings = await client
        .from("app_settings")
        .select("ai_enabled,ai_media_enabled,ai_model")
        .eq("id", true)
        .single();
      if (liveSettings.error || !liveSettings.data) {
        console.warn(
          "whatsapp-automation",
          "OPENAI_MEDIA_CONTROL_UNAVAILABLE",
          {
            code: liveSettings.error?.message ?? "NO_SETTINGS",
          },
        );
        return false;
      }

      return mediaOpenAIEnabled({
        globalAutomationsEnabled,
        serverEnabled,
        aiEnabled: liveSettings.data.ai_enabled,
        aiMediaEnabled: liveSettings.data.ai_media_enabled,
        model: liveSettings.data.ai_model,
      });
    };

    // La decisión durable no transmite bytes y debe sobrevivir a un apagado
    // posterior de los switches. Sólo una lectura todavía inexistente exige
    // tanto el permiso del snapshot como los controles vivos.
    const mediaDecisionEligible =
      priorDepositProofResult === null && mediaMessage && mediaContextReady;
    let depositProofMediaFailureReason: DepositProofMediaFailureReason | null =
      depositProofMediaContextReady &&
      priorDepositProofResult === null &&
      !mediaDecisionEligible
        ? "MEDIA_DISABLED"
        : null;

    if (mediaDecisionEligible) {
      const lease = executionLease;
      if (!lease) throw new Error("AUTOMATION_EXECUTION_LEASE_LOST");
      const sequence = decisionSequence;
      decisionSequence += 1;
      try {
        const recalled = await client.rpc(
          "recall_whatsapp_automation_decision",
          {
            p_message_id: lease.messageId,
            p_lease_token: lease.leaseToken,
            p_sequence: sequence,
            p_key: "openai_media_understanding",
          },
        );
        if (recalled.error) throw recalled.error;
        const remembered = recalled.data as { value?: unknown } | null;
        if (remembered && "value" in remembered) {
          mediaUnderstanding = normalizeDurableMediaUnderstanding(
            remembered.value,
          );
          if (!mediaUnderstanding) {
            throw new Error("OPENAI_MEDIA_DURABLE_RESPONSE_INVALID");
          }
        } else {
          // Consultar la decisión durable no transmite contenido. Los
          // switches vivos se exigen recién antes de descargar y enviar un
          // archivo que todavía no fue procesado.
          if (!snapshotMediaEnabled || !(await readLiveMediaOpenAIEnabled())) {
            throw new Error("OPENAI_MEDIA_DISABLED_LIVE");
          }
          const media = await downloadInboundWhatsAppMedia({
            client,
            message: inbound as unknown as Record<string, unknown>,
            fetchImpl: fetch,
            maxBytes: whatsappMediaMaxBytes(
              Deno.env.get("WHATSAPP_MEDIA_MAX_BYTES"),
            ),
          });
          // La descarga puede tardar. Revalidar inmediatamente antes de enviar
          // bytes evita que un apagado ocurrido durante ella quede ignorado.
          if (!(await readLiveMediaOpenAIEnabled())) {
            throw new Error("OPENAI_MEDIA_DISABLED_LIVE");
          }
          if (inbound.type === "audio") {
            mediaUnderstanding = {
              kind: "audio",
              transcription: await requestAudioTranscription({
                apiKey: Deno.env.get("OPENAI_API_KEY") ?? "",
                bytes: media.bytes,
                mimeType: media.descriptor.mimeType,
                safetyIdentifier: await administrativeSafetyIdentifier(
                  contact.id as string,
                ),
              }),
            };
          } else {
            mediaUnderstanding = {
              kind: "deposit_proof",
              reading: await requestDepositProofReading({
                apiKey: Deno.env.get("OPENAI_API_KEY") ?? "",
                bytes: media.bytes,
                mimeType: media.descriptor.mimeType,
                safetyIdentifier: await administrativeSafetyIdentifier(
                  contact.id as string,
                ),
              }),
              mediaSha256: await mediaSha256Hex(media.bytes),
            };
          }

          const stored = await client.rpc(
            "remember_whatsapp_automation_decision",
            {
              p_message_id: lease.messageId,
              p_lease_token: lease.leaseToken,
              p_sequence: sequence,
              p_key: "openai_media_understanding",
              p_value: { value: mediaUnderstanding },
            },
          );
          if (stored.error) throw stored.error;
          const storedValue = stored.data as { value?: unknown } | null;
          mediaUnderstanding = normalizeDurableMediaUnderstanding(
            storedValue?.value,
          );
          if (!mediaUnderstanding) {
            throw new Error("OPENAI_MEDIA_DURABLE_RESPONSE_INVALID");
          }
        }
      } catch (error) {
        const failureCode = error instanceof Error ? error.message : "UNKNOWN";
        console.warn("whatsapp-automation", "MEDIA_UNDERSTANDING_FAILED", {
          code: failureCode,
        });
        if (depositProofMediaContextReady) {
          depositProofMediaFailureReason = failureCode.includes(
            "OPENAI_MEDIA_DISABLED",
          )
            ? "MEDIA_DISABLED"
            : /^(MEDIA_|WHATSAPP_MEDIA_)/.test(failureCode)
              ? "DOWNLOAD_FAILED"
              : "READING_FAILED";
        }
        mediaUnderstanding = null;
      }
    }

    if (
      mediaUnderstanding?.kind === "audio" &&
      mediaUnderstanding.transcription.audible
    ) {
      inboundBody = mediaUnderstanding.transcription.transcript;
      const transcribedMessage: NormalizedIncomingMessage = {
        externalMessageId: inbound.id,
        phoneE164: contact.phone_e164,
        whatsappId: contact.whatsapp_id,
        whatsappUserId: contact.whatsapp_user_id,
        profileName: contact.name,
        type: "text",
        body: inboundBody,
        metadata,
        receivedAt: execution.snapshot_at,
      };
      transcribedAudioPriority = requiresPriority(transcribedMessage);
      transcribedAudioNeedsHuman = requiresHumanReview(transcribedMessage);
      await client
        .from("messages")
        .update({
          metadata: {
            ...metadata,
            transcript: mediaUnderstanding.transcription.transcript,
          },
        })
        .eq("id", inbound.id);

      // Una baja explícita vale igual por texto que por nota de voz. La RPC
      // vincula la transcripción al mensaje/lease exactos y deja la
      // conversación en manual sin enviar una respuesta posterior.
      if (whatsappConsentDecisionFromText(inboundBody) === "opt_out") {
        const lease = executionLease;
        if (!lease) throw new Error("AUTOMATION_EXECUTION_LEASE_LOST");
        const optOut = await client.rpc("record_transcribed_whatsapp_opt_out", {
          p_message_id: inbound.id,
          p_lease_token: lease.leaseToken,
        });
        if (optOut.error || optOut.data !== true) {
          throw new Error(
            `TRANSCRIBED_OPT_OUT_FAILED:${optOut.error?.message ?? "NOT_APPLIED"}`,
          );
        }
        return await finish({
          processed: true,
          state: "opted_out",
          reason: "TRANSCRIBED_OPT_OUT",
        });
      }
    }

    /** Un adjunto opaco nunca se interpreta usando su cuerpo de relleno
     * ("Nota de voz", "Imagen" o "Documento"). */
    unreadableMedia =
      mediaMessage &&
      (mediaUnderstanding === null ||
        (mediaUnderstanding.kind === "audio" &&
          !mediaUnderstanding.transcription.audible));
    normalizedInboundBody = normalizeUserInput(inboundBody);
    inputValue = replyId || inboundBody;

    const handoff = async (
      reason = "",
      context: AutomationContext = {},
      confirmationMessage?: string,
    ) => {
      await claimInboundHandoff(client, inbound.id);
      const handoffMessage =
        confirmationMessage ??
        `${reason ? `${reason.trim()} ` : ""}` +
          "Voy a derivar tu consulta para que puedan ayudarte 😊";
      await send(
        textPayload(handoffMessage),
        handoffMessage,
        { human_handoff: true },
        "handoff",
      );
      await saveSession("human_handoff", context);
    };

    const respondToDepositProofResult = async (
      proof: AutomatedDepositProofResult,
    ): Promise<Response> => {
      if (proof.status === "superseded") {
        await handoff(
          "Recibimos tu comprobante, pero necesitamos revisar el estado actual del turno.",
          { appointmentId: proof.appointmentId },
        );
        return await finish({
          processed: true,
          reason: "DEPOSIT_PROOF_SUPERSEDED",
          state: "human_handoff",
          appointmentId: proof.appointmentId,
        });
      }

      if (
        proof.status === "confirmed" ||
        proof.status === "already_confirmed"
      ) {
        const automaticallyConfirmed =
          proof.status === "confirmed" ||
          proof.confirmationActor === "automatic_system" ||
          proof.originalStatus === "confirmed";
        if (proof.status === "confirmed") {
          committedDomainEffect = {
            conversationId: conversation.id,
            appointmentId: proof.appointmentId,
            type: "deposit_confirm",
          };
        }
        const template = appSettings.deposit_confirmed_message_template?.trim();
        const defaultConfirmationMessage = `¡Listo! Recibimos el comprobante y tu turno quedó confirmado para el ${formatDate(proof.startsAt)} a las ${formatTime(proof.startsAt)}.`;
        const renderedConfirmationMessage = template
          ? renderConfiguredMessage(template, {
              date: formatDate(proof.startsAt),
              time: formatTime(proof.startsAt),
            })
          : "";
        const validRenderedConfirmation =
          renderedConfirmationMessage.length > 0 &&
          renderedConfirmationMessage.length <= 4096 &&
          !/\{[A-Za-z][A-Za-z0-9_]*\}/.test(renderedConfirmationMessage);
        const message = automaticallyConfirmed
          ? validRenderedConfirmation
            ? renderedConfirmationMessage
            : defaultConfirmationMessage
          : `Tu turno para el ${formatDate(proof.startsAt)} a las ${formatTime(proof.startsAt)} ya estaba confirmado.`;
        await send(
          textPayload(message),
          message,
          {
            appointment_id: proof.appointmentId,
            proof_message_id: inbound.id,
            deposit_auto_confirmed: automaticallyConfirmed,
            deposit_confirmation_actor: automaticallyConfirmed
              ? "automatic_system"
              : "human_operator",
            deposit_policy: "deposit-proof-basic/v1",
          },
          "deposit_confirmation",
          proof.appointmentId,
        );
        return await finish({
          processed: true,
          state: "deposit_confirmed",
          appointmentId: proof.appointmentId,
        });
      }

      const message = depositProofReviewMessage(
        appSettings.deposit_proof_received_message_template,
        proof.status === "late",
      );
      await send(
        textPayload(message),
        message,
        {
          appointment_id: proof.appointmentId,
          proof_message_id: inbound.id,
          deposit_review_required: true,
          deposit_validation_reasons: proof.reviewReasons,
        },
        proof.status === "late"
          ? "late_proof_acknowledgement"
          : "proof_acknowledgement",
        proof.appointmentId,
      );
      return await finish({
        processed: true,
        state: proof.status === "late" ? "late_deposit_proof" : "human_handoff",
        appointmentId: proof.appointmentId,
      });
    };

    let contactPhoneConfirmed =
      session.context.contactPhoneConfirmed === true ||
      (typeof contact.alternate_phone_e164 === "string" &&
        Boolean(contact.alternate_phone_e164)) ||
      (typeof contact.phone_e164 === "string" &&
        /^\+[1-9][0-9]{7,14}$/.test(contact.phone_e164));

    const currentProfile = () => ({
      name: typeof contact.name === "string" ? contact.name : null,
      isExistingPatient:
        typeof contact.is_existing_patient === "boolean"
          ? contact.is_existing_patient
          : null,
      contactPhoneConfirmed,
      coverage:
        contact.coverage === "ioma" || contact.coverage === "particular"
          ? (contact.coverage as PatientCoverage)
          : null,
    });

    const persistProfileInput = async (
      expectedField: PatientProfileField | null = null,
      requireStructuredReply = false,
    ): Promise<boolean> => {
      // El relleno de un adjunto ilegible nunca completa un dato del perfil.
      if (!replyId && unreadableMedia) return false;
      const parsed = parsePatientProfileReply(inputValue, {
        expectedField,
        primaryPhoneE164:
          typeof contact.phone_e164 === "string" ? contact.phone_e164 : null,
      });
      const structuredFieldCount = [
        parsed.values.name,
        parsed.values.isExistingPatient,
        parsed.values.contactPhoneConfirmed,
        parsed.values.coverage,
      ].filter((field) => field !== undefined).length;
      if (requireStructuredReply && structuredFieldCount < 2) return false;
      if (parsed.values.contactPhoneConfirmed) {
        contactPhoneConfirmed = true;
      }
      const updates: Record<string, unknown> = {};
      if (parsed.values.name) updates.name = parsed.values.name;
      if (typeof parsed.values.isExistingPatient === "boolean") {
        updates.is_existing_patient = parsed.values.isExistingPatient;
      }
      if (parsed.values.coverage) updates.coverage = parsed.values.coverage;
      if (parsed.values.alternatePhoneE164) {
        updates.alternate_phone_e164 = parsed.values.alternatePhoneE164;
      }
      if (!Object.keys(updates).length) {
        return parsed.values.contactPhoneConfirmed === true;
      }

      const lease = executionLease;
      if (!lease) throw new Error("AUTOMATION_EXECUTION_LEASE_LOST");
      const { data: updatedContact, error } = await client.rpc(
        "apply_whatsapp_automation_profile",
        {
          p_message_id: lease.messageId,
          p_lease_token: lease.leaseToken,
          p_updates: updates,
        },
      );
      if (error || !updatedContact) {
        throw error ?? new Error("PATIENT_PROFILE_UPDATE_FAILED");
      }
      Object.assign(contact, updatedContact);
      return true;
    };

    const askForMissingProfile = async (
      invalidAttempts = 0,
      continueAfterProfile: AutomationContext["continueAfterProfile"] = "services",
      continuationContext: Pick<
        AutomationContext,
        "serviceId" | "serviceName"
      > = {},
    ): Promise<boolean> => {
      const missing = missingPatientProfileFields(currentProfile());
      const field = missing[0];
      if (!field) return false;

      if (field === "name") {
        const message = PATIENT_PROFILE_PROMPTS.name;
        await send(textPayload(message), message);
      } else if (field === "is_existing_patient") {
        const message = PATIENT_PROFILE_PROMPTS.is_existing_patient;
        await send(
          buttonsPayload(message, [
            { id: "profile:existing:yes", title: "Sí" },
            { id: "profile:existing:no", title: "No" },
          ]),
          message,
        );
      } else if (field === "contact_phone") {
        const hasWhatsAppPhone =
          typeof contact.phone_e164 === "string" && Boolean(contact.phone_e164);
        const message = hasWhatsAppPhone
          ? PATIENT_PROFILE_PROMPTS.contact_phone
          : "¿Cuál es tu teléfono de contacto? Escribilo con código de área.";
        await send(
          hasWhatsAppPhone
            ? buttonsPayload(message, [
                {
                  id: "profile:phone:whatsapp",
                  title: "Este WhatsApp",
                },
              ])
            : textPayload(message),
          message,
        );
      } else {
        const message = PATIENT_PROFILE_PROMPTS.coverage;
        await send(
          buttonsPayload(message, [
            { id: "profile:coverage:ioma", title: "IOMA" },
            { id: "profile:coverage:particular", title: "Particular" },
            { id: "profile:coverage:other", title: "Otra cobertura" },
          ]),
          message,
        );
      }

      await saveSession(
        "collecting_patient_profile",
        {
          ...continuationContext,
          expectedProfileField: field,
          contactPhoneConfirmed,
          continueAfterProfile,
          invalidAttempts,
        },
        60,
      );
      return true;
    };

    // El número personal autorizado consulta su propia agenda: nunca entra al
    // flujo de reserva ni recibe el menú de pacientes.
    if (isOwnerNumber(contact.phone_e164, ownerNumbersFromEnvironment())) {
      const requested = detectOwnerRequest(inboundBody);
      let reply = OWNER_HELP_MESSAGE;

      if (requested?.kind === "agenda") {
        const now = new Date();
        const dayOffset = requested.day === "tomorrow" ? 1 : 0;
        const from = new Date(now);
        if (requested.day !== "week") {
          from.setUTCDate(from.getUTCDate() + dayOffset);
          from.setUTCHours(0, 0, 0, 0);
        }
        const until = new Date(from);
        until.setUTCDate(
          until.getUTCDate() + (requested.day === "week" ? 7 : 1),
        );

        const { data, error } = await client
          .from("appointments")
          .select(
            "starts_at,coverage,deposit_status,contacts(name,phone_e164),services(name)",
          )
          .gte("starts_at", from.toISOString())
          .lt("starts_at", until.toISOString())
          .in("status", ["scheduled", "confirmed"])
          .order("starts_at");
        if (error) throw error;

        const appointments: OwnerAgendaAppointment[] = (data ?? []).map(
          (row) => {
            const patient = Array.isArray(row.contacts)
              ? row.contacts[0]
              : row.contacts;
            const service = Array.isArray(row.services)
              ? row.services[0]
              : row.services;
            return {
              startsAt: row.starts_at as string,
              patientName: (patient?.name as string) ?? "Sin nombre",
              patientPhone: (patient?.phone_e164 as string) ?? null,
              coverage: (row.coverage as string) ?? null,
              service: (service?.name as string) ?? null,
              depositStatus: (row.deposit_status as string) ?? null,
            };
          },
        );
        reply = formatOwnerAgenda({
          appointments,
          day: requested.day,
          timezone: businessTimezone,
        });
      } else if (requested?.kind === "patient") {
        const { data, error } = await client
          .from("contacts")
          .select("id,name,phone_e164,coverage,administrative_notes")
          .ilike("name", `%${requested.query}%`)
          .limit(9);
        if (error) throw error;

        const matches = await Promise.all(
          (data ?? []).map(async (row) => {
            const { data: next } = await client
              .from("appointments")
              .select("starts_at,coverage,deposit_status,services(name)")
              .eq("contact_id", row.id)
              .gte("starts_at", new Date().toISOString())
              .in("status", ["scheduled", "confirmed"])
              .order("starts_at")
              .limit(1)
              .maybeSingle();
            return {
              name: row.name as string,
              phone: (row.phone_e164 as string) ?? null,
              coverage: (row.coverage as string) ?? null,
              notes: (row.administrative_notes as string) ?? null,
              nextAppointment: next
                ? {
                    startsAt: next.starts_at as string,
                    patientName: row.name as string,
                    patientPhone: (row.phone_e164 as string) ?? null,
                    coverage: (next.coverage as string) ?? null,
                    service: null,
                    depositStatus: (next.deposit_status as string) ?? null,
                  }
                : null,
            };
          }),
        );
        reply = formatOwnerPatient({
          matches,
          query: requested.query,
          timezone: businessTimezone,
        });
      }

      await send(
        textPayload(reply),
        reply,
        { owner_request: requested?.kind ?? "help" },
        "owner_access",
      );
      // Cada respuesta con datos de pacientes queda registrada.
      await client.from("audit_logs").insert({
        action: "whatsapp.owner_private_answer",
        entity_type: "conversation",
        entity_id: conversation.id,
        metadata: { request: requested?.kind ?? "help" },
      });
      await saveSession("idle");
      return await finish({ processed: true, state: "owner_access" });
    }

    // El efecto transaccional es la decisión durable. Si el envío falló después
    // del commit, un retry reutiliza el resultado sin volver a descargar el
    // archivo, llamar a OpenAI ni cambiar una revisión por una confirmación.
    if (priorDepositProofResult) {
      return await respondToDepositProofResult(priorDepositProofResult);
    }

    if (depositProofMediaContextReady && mediaUnderstanding === null) {
      const proofLease = executionLease;
      if (!proofLease) throw new Error("AUTOMATION_EXECUTION_LEASE_LOST");
      const reviewResult = await client.rpc(
        "route_automated_deposit_proof_to_review",
        {
          p_message_id: inbound.id,
          p_lease_token: proofLease.leaseToken,
          p_appointment_id: snapshotAppointmentId,
          p_reason: depositProofMediaFailureReason ?? "UNREADABLE",
        },
      );
      if (reviewResult.error) {
        if (isDepositProofReviewableRpcError(reviewResult.error)) {
          await handoff("No pudimos asociar el comprobante automáticamente.", {
            appointmentId: snapshotAppointmentId,
          });
          return await finish({
            processed: true,
            state: "human_handoff",
            appointmentId: snapshotAppointmentId,
          });
        }
        throw new Error(
          `AUTOMATED_DEPOSIT_PROOF_REVIEW_FAILED:${reviewResult.error.message}`,
        );
      }
      const proof = normalizeAutomatedDepositProofResult(reviewResult.data);
      if (!proof) {
        throw new Error("AUTOMATED_DEPOSIT_PROOF_REVIEW_RESULT_INVALID");
      }
      return await respondToDepositProofResult(proof);
    }

    if (unreadableMedia) {
      const reason =
        inbound.type === "audio"
          ? "No pudimos escuchar el audio automáticamente."
          : session.state === "waiting_deposit"
            ? "No pudimos leer el comprobante automáticamente."
            : "Recibimos el archivo.";
      await handoff(reason);
      return await finish({ processed: true, state: "human_handoff" });
    }

    if (
      inbound.type !== "audio" &&
      (inbound.type === "image" || inbound.type === "document") &&
      mediaUnderstanding?.kind === "deposit_proof"
    ) {
      const appointmentId = session.context.appointmentId;
      if (session.state !== "waiting_deposit" || !appointmentId) {
        await handoff(
          "No pudimos asociar este archivo a una pre-reserva activa.",
        );
        return await finish({ processed: true, state: "human_handoff" });
      }

      const proofAppointmentResult = await client
        .from("appointments")
        .select(
          "deposit_expected_amount_ars,deposit_expected_alias,deposit_expected_holder",
        )
        .eq("id", appointmentId)
        .eq("contact_id", contact.id)
        .maybeSingle();
      if (proofAppointmentResult.error) throw proofAppointmentResult.error;
      const proofAppointment = proofAppointmentResult.data;
      const expectedAmount = Number(
        proofAppointment?.deposit_expected_amount_ars,
      );
      const expectedAlias =
        typeof proofAppointment?.deposit_expected_alias === "string"
          ? proofAppointment.deposit_expected_alias.trim()
          : "";
      const expectedHolder =
        typeof proofAppointment?.deposit_expected_holder === "string"
          ? proofAppointment.deposit_expected_holder.trim()
          : "";
      const configured =
        Number.isSafeInteger(expectedAmount) &&
        expectedAmount > 0 &&
        Boolean(expectedAlias) &&
        Boolean(expectedHolder);
      const validation = configured
        ? validateDepositProofForAutoConfirmation({
            reading: mediaUnderstanding.reading,
            expectedAmountArs: expectedAmount,
            expectedAlias,
            expectedHolder,
          })
        : {
            approved: false,
            reasons: ["CONFIGURATION_INCOMPLETE"],
          };

      const proofLease = executionLease;
      if (!proofLease) throw new Error("AUTOMATION_EXECUTION_LEASE_LOST");
      const proofResult = await client.rpc("process_automated_deposit_proof", {
        p_message_id: inbound.id,
        p_lease_token: proofLease.leaseToken,
        p_appointment_id: appointmentId,
        p_reading: {
          legible: mediaUnderstanding.reading.legible,
          amount: mediaUnderstanding.reading.amount,
          currency: mediaUnderstanding.reading.currency,
          date: mediaUnderstanding.reading.date,
          destination: mediaUnderstanding.reading.destination,
          holder: mediaUnderstanding.reading.holder,
          operationId: mediaUnderstanding.reading.operationId,
        },
        p_media_sha256: mediaUnderstanding.mediaSha256,
        p_policy_version: "deposit-proof-basic/v1",
        p_auto_approve: validation.approved,
      });
      if (proofResult.error) {
        if (isDepositProofReviewableRpcError(proofResult.error)) {
          await handoff(
            "No pudimos confirmar este comprobante automáticamente.",
            { appointmentId },
          );
          return await finish({
            processed: true,
            state: "human_handoff",
            appointmentId,
          });
        }
        throw new Error(
          `AUTOMATED_DEPOSIT_PROOF_FAILED:${proofResult.error.message}`,
        );
      }
      const proof = normalizeAutomatedDepositProofResult(proofResult.data);
      if (!proof) throw new Error("AUTOMATED_DEPOSIT_PROOF_RESULT_INVALID");
      return await respondToDepositProofResult(proof);
    }

    // Un comprobante que llega fuera de la ventana `waiting_deposit` —sesión
    // vencida, turno cargado desde el panel, atención humana en curso— antes
    // no recibía ninguna respuesta: la ejecución terminaba en `ignored` unas
    // líneas más abajo. Ahora se acusa recibo una sola vez por archivo y el
    // comprobante queda en la cola de revisión humana. El acuse no promete
    // que la seña haya sido validada.
    if (depositProofMediaMessage && !depositProofMediaContextReady) {
      const reviewClaim = await client.rpc("claim_deposit_proof_review", {
        p_contact_id: contact.id,
        p_message_id: inbound.id,
        p_received_at: executionNow.toISOString(),
      });
      if (reviewClaim.error) throw reviewClaim.error;
      const review = (
        Array.isArray(reviewClaim.data) ? reviewClaim.data[0] : reviewClaim.data
      ) as {
        appointment_id?: string | null;
        recognized?: boolean;
        acknowledge?: boolean;
      } | null;

      if (review?.recognized && review.appointment_id) {
        if (review.acknowledge !== true) {
          // Ya se acusó recibo de este mismo archivo. Un reintento del worker
          // no vuelve a escribirle al paciente.
          return await finish({
            processed: true,
            state: "human_handoff",
            reason: "DEPOSIT_PROOF_ALREADY_ACKNOWLEDGED",
            appointmentId: review.appointment_id,
          });
        }
        const acknowledgement = depositProofReviewMessage(
          appSettings.deposit_proof_received_message_template,
          false,
        );
        await claimInboundHandoff(
          client,
          inbound.id,
          false,
          "deposit_proof_received",
        );
        await send(
          textPayload(acknowledgement),
          acknowledgement,
          {
            appointment_id: review.appointment_id,
            proof_message_id: inbound.id,
            deposit_review_required: true,
            deposit_review_source: "out_of_session_media",
          },
          "proof_acknowledgement",
          review.appointment_id,
        );
        await saveSession("human_handoff", {
          appointmentId: review.appointment_id,
        });
        return await finish({
          processed: true,
          state: "human_handoff",
          reason: "DEPOSIT_PROOF_PENDING_REVIEW",
          appointmentId: review.appointment_id,
        });
      }
    }

    if (conversation.priority === true || transcribedAudioPriority) {
      await claimInboundHandoff(client, inbound.id, true, "urgent_handoff");
      const urgentMessage =
        typeof appSettings?.urgent_message === "string" &&
        appSettings.urgent_message.trim()
          ? appSettings.urgent_message.trim()
          : "Marcamos tu mensaje como urgente y vamos a derivarlo para que puedan responderte cuanto antes. Si es una emergencia grave, contactá al servicio de emergencias de tu zona.";
      await send(
        textPayload(urgentMessage),
        urgentMessage,
        { priority_handoff: true },
        "urgent_handoff",
      );
      await saveSession("human_handoff");
      return await finish({
        processed: true,
        state: "urgent_handoff",
      });
    }

    if (transcribedAudioNeedsHuman) {
      await handoff(
        "Por el contenido del audio, esta consulta necesita atención humana.",
      );
      return await finish({
        processed: true,
        state: "human_handoff",
      });
    }

    if (conversation.automation_mode !== "auto") {
      return await finish({ ignored: true });
    }

    if (isSecretaryRequest(inputValue)) {
      await handoff("", {}, SECRETARY_HANDOFF_MESSAGE);
      return await finish({
        processed: true,
        state: "human_handoff",
        reason: "SECRETARY_REQUESTED",
      });
    }

    if (
      freshSession &&
      appSettings?.out_of_hours_enabled === true &&
      typeof appSettings.out_of_hours_message === "string" &&
      appSettings.out_of_hours_message.trim()
    ) {
      const nowParts = new Intl.DateTimeFormat("en-US", {
        timeZone: businessTimezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).formatToParts(executionNow);
      const weekdayName = nowParts.find(
        (part) => part.type === "weekday",
      )?.value;
      const weekdayIndex = [
        "Sun",
        "Mon",
        "Tue",
        "Wed",
        "Thu",
        "Fri",
        "Sat",
      ].indexOf(weekdayName ?? "");
      const hour = nowParts.find((part) => part.type === "hour")?.value ?? "00";
      const minute =
        nowParts.find((part) => part.type === "minute")?.value ?? "00";
      const localTime = `${hour}:${minute}:00`;
      const localDate = ["year", "month", "day"]
        .map((type) => nowParts.find((part) => part.type === type)?.value ?? "")
        .join("-");
      const [openRulesResult, exceptionsResult] = await Promise.all([
        client
          .from("availability_rules")
          .select("id,professionals!inner(active)")
          .eq("professionals.active", true)
          .eq("weekday", weekdayIndex)
          .eq("active", true)
          .lte("start_time", localTime)
          .gt("end_time", localTime)
          .limit(1),
        client
          .from("availability_exceptions")
          .select("type,start_time,end_time,professionals!inner(active)")
          .eq("professionals.active", true)
          .eq("date", localDate),
      ]);
      const exceptions = (exceptionsResult.data ?? []) as Array<{
        type: "available" | "unavailable";
        start_time: string | null;
        end_time: string | null;
      }>;
      const coversCurrentTime = (exception: (typeof exceptions)[number]) =>
        (!exception.start_time && !exception.end_time) ||
        Boolean(
          exception.start_time &&
          exception.end_time &&
          exception.start_time <= localTime &&
          exception.end_time > localTime,
        );
      const explicitlyUnavailable = exceptions.some(
        (exception) =>
          exception.type === "unavailable" && coversCurrentTime(exception),
      );
      const exceptionallyAvailable = exceptions.some(
        (exception) =>
          exception.type === "available" && coversCurrentTime(exception),
      );
      if (openRulesResult.error || exceptionsResult.error) {
        throw openRulesResult.error ?? exceptionsResult.error;
      }
      const currentlyOpen = await durableDecision(
        "out_of_hours_open",
        !explicitlyUnavailable &&
          (Boolean(openRulesResult.data?.length) || exceptionallyAvailable),
      );

      if (!currentlyOpen) {
        const outOfHoursMessage = appSettings.out_of_hours_message.trim();
        await send(textPayload(outOfHoursMessage), outOfHoursMessage, {
          out_of_hours: true,
        });
        const cooldown = Number(appSettings.out_of_hours_cooldown_minutes);
        await saveSession(
          "out_of_hours",
          {},
          Number.isFinite(cooldown) ? cooldown : 720,
        );
        return await finish({
          processed: true,
          state: "out_of_hours",
        });
      }
    }

    const showMainMenu = async (message = "¿En qué más podemos ayudarte?") => {
      await send(
        listPayload(message, "Ver opciones", APPOINTMENT_MAIN_MENU_OPTIONS),
        message,
      );
      await saveSession("idle");
    };

    const invalid = async (repeat: (attempts: number) => Promise<void>) => {
      const { attempts, shouldHandoff } = nextInvalidAttempt(
        session.context.invalidAttempts,
      );
      if (shouldHandoff) {
        await handoff("No pudimos interpretar la opción.");
        return;
      }
      await repeat(attempts);
    };

    const showServices = async (page = 0, invalidAttempts = 0) => {
      const { data, error } = await client
        .from("services")
        .select("id,name,description,sort_order")
        .eq("active", true)
        .order("sort_order")
        .order("name");
      if (error) throw error;
      const services = await durableDecision(
        `services_page_${page}`,
        data ?? [],
      );
      if (!services.length) {
        await handoff(
          "Todavía no tenemos servicios disponibles para reservar.",
        );
        return;
      }

      const pageSize = 8;
      const lastPage = Math.max(0, Math.ceil(services.length / pageSize) - 1);
      const safePage = Math.min(Math.max(0, page), lastPage);
      const rows: Array<{ id: string; title: string; description?: string }> =
        [];
      rows.push(
        ...services
          .slice(safePage * pageSize, (safePage + 1) * pageSize)
          .map((service) => ({
            id: `svc:${service.id}`,
            title: (service.name as string).slice(0, 24),
            description:
              typeof service.description === "string" && service.description
                ? service.description.slice(0, 72)
                : "Motivo del turno",
          })),
      );
      if (safePage > 0) {
        rows.push({ id: "services:prev", title: "← Anteriores" });
      }
      if (safePage < lastPage) {
        rows.push({ id: "services:next", title: "Más servicios →" });
      }
      rows.push({ id: "flow:menu", title: "← Menú principal" });

      await send(
        listPayload(
          "¿Qué tipo de turno necesitás? Elegí un servicio para ver horarios disponibles.",
          "Elegir servicio",
          rows,
        ),
        "Elegí el tipo de turno que necesitás.",
      );
      await saveSession("selecting_service", {
        professionalPage: safePage,
        invalidAttempts,
      });
    };

    const findSlots = async (
      professionalId: string,
      professionalName: string,
      serviceId: string,
      serviceName: string,
      coverage: PatientCoverage,
      limit = 8,
    ): Promise<AutomationSlot[]> => {
      // Se recorren varios días y se toman pocos de cada uno: así la lista
      // abarca distintos días en vez de agotarse en el primero que esté
      // abierto.
      const slotsByDay: AutomationSlot[][] = [];
      const maxDaysOffered = Math.ceil(limit / MAX_SLOTS_OFFERED_PER_DAY);
      for (
        let offset = 0;
        offset < 21 && slotsByDay.length < maxDaysOffered;
        offset += 1
      ) {
        const date = new Date(executionNow);
        date.setDate(date.getDate() + offset);
        const { data, error } = await client.rpc(
          "get_available_slots_for_coverage",
          {
            p_professional_id: professionalId,
            p_coverage: coverage,
            p_date: dateInTimezone(date, businessTimezone),
            p_timezone: businessTimezone,
            p_limit: MAX_SLOTS_OFFERED_PER_DAY,
          },
        );
        if (error) throw error;
        const day = (data ?? []).map(
          (slot: { starts_at: string; ends_at: string }) => ({
            startsAt: slot.starts_at,
            endsAt: slot.ends_at,
            professionalId,
            professionalName,
            serviceId,
            serviceName,
          }),
        );
        if (day.length) slotsByDay.push(day);
      }
      return await durableDecision(
        "available_slots",
        selectSlotsForOffer(slotsByDay, MAX_SLOTS_OFFERED_PER_DAY, limit),
      );
    };

    const showSlots = async (
      professionalId: string,
      professionalName: string,
      serviceId: string,
      serviceName: string,
      state: "selecting_slot" | "selecting_new_slot",
      context: AutomationContext = {},
      invalidAttempts = 0,
    ): Promise<boolean> => {
      const slotCoverage = currentProfile().coverage;
      if (!slotCoverage) {
        await handoff(
          "Necesitamos revisar la cobertura de este turno antes de reprogramarlo.",
        );
        return false;
      }
      const slots = await findSlots(
        professionalId,
        professionalName,
        serviceId,
        serviceName,
        slotCoverage,
      );
      if (!slots.length) {
        await handoff("No encontramos horarios disponibles.");
        return false;
      }
      const rows: Array<{ id: string; title: string; description?: string }> =
        slots.map((slot, index) => ({
          id: `slot:${index}`,
          title: slotOptionLabel(slot).slice(0, 24),
          description: slot.serviceName.slice(0, 72),
        }));
      rows.push(
        state === "selecting_slot"
          ? { id: "nav:services", title: "← Cambiar servicio" }
          : { id: "reschedule:back", title: "← Conservar mi turno" },
      );
      await send(
        listPayload(
          state === "selecting_slot"
            ? "Estos son los próximos horarios disponibles:"
            : "Elegí un nuevo horario. Tu turno actual se conserva hasta que confirmes el cambio.",
          "Ver horarios",
          rows,
        ),
        "Estos son los próximos horarios disponibles.",
      );
      await saveSession(state, {
        ...context,
        professionalId,
        professionalName,
        serviceId,
        serviceName,
        slots,
        invalidAttempts,
      });
      return true;
    };

    const findTypedService = async (value: string) => {
      const { data, error } = await client
        .from("services")
        .select("id,name")
        .eq("active", true);
      if (error) throw error;
      const serviceOptions = await durableDecision(
        "typed_service_options",
        (data ?? []) as Array<{ id: string; name: string }>,
      );
      return resolveTypedServiceOption(value, serviceOptions);
    };

    const selectServiceAndShowSlots = async (
      serviceId: string,
    ): Promise<"shown" | "handoff" | "missing"> => {
      const [serviceResult, professionalResult] = await Promise.all([
        client
          .from("services")
          .select("id,name")
          .eq("id", serviceId)
          .eq("active", true)
          .maybeSingle(),
        client
          .from("professionals")
          .select("id,name")
          .eq("active", true)
          .order("created_at")
          .limit(1)
          .maybeSingle(),
      ]);
      if (serviceResult.error || professionalResult.error) {
        throw serviceResult.error ?? professionalResult.error;
      }
      const selection = await durableDecision("service_professional", {
        service: serviceResult.data,
        professional: professionalResult.data,
      });
      if (!selection.service || !selection.professional) {
        return "missing";
      }
      const shown = await showSlots(
        selection.professional.id as string,
        selection.professional.name as string,
        selection.service.id as string,
        selection.service.name as string,
        "selecting_slot",
      );
      return shown ? "shown" : "handoff";
    };

    const startNewAppointmentFlow = async (
      requestedService: { id: string; name: string } | null = null,
    ) => {
      const continuationContext = requestedService
        ? {
            serviceId: requestedService.id,
            serviceName: requestedService.name,
          }
        : {};
      if (await askForMissingProfile(0, "services", continuationContext)) {
        return;
      }
      if (requestedService) {
        const result = await selectServiceAndShowSlots(requestedService.id);
        if (result === "missing") {
          await showServices();
        }
        return;
      }
      await showServices();
    };

    const upcomingAppointments = async (limit = 10) => {
      const { data, error } = await client
        .from("appointments")
        .select(
          "id,professional_id,service_id,starts_at,status,deposit_status,hold_expires_at,professionals!appointments_professional_id_fkey(name),services!appointments_service_id_fkey(name)",
        )
        .eq("contact_id", contact.id)
        .in("status", ["scheduled", "confirmed"])
        .gte("starts_at", executionNow.toISOString())
        .order("starts_at")
        .limit(limit);
      if (error) throw error;
      const appointments = (data ?? [])
        .filter(
          (appointment) =>
            appointment.status === "confirmed" ||
            appointment.deposit_status !== "pending" ||
            !appointment.hold_expires_at ||
            new Date(appointment.hold_expires_at as string).getTime() >
              executionNow.getTime(),
        )
        .map(
          (appointment): AppointmentSummary => ({
            id: appointment.id as string,
            professionalId: appointment.professional_id as string,
            professionalName: appointmentRelationName(
              appointment.professionals as
                | { name?: string }
                | Array<{ name?: string }>
                | null,
            ),
            serviceId: appointment.service_id as string,
            serviceName: appointmentRelationName(
              appointment.services as
                | { name?: string }
                | Array<{ name?: string }>
                | null,
            ),
            startsAt: appointment.starts_at as string,
            status: appointment.status as "scheduled" | "confirmed",
            depositStatus:
              appointment.deposit_status as AppointmentSummary["depositStatus"],
            holdExpiresAt:
              (appointment.hold_expires_at as string | null) ?? null,
          }),
        );
      return await durableDecision(
        `upcoming_appointments_${limit}`,
        appointments,
      );
    };

    const activeAppointmentById = async (
      appointmentId: string,
    ): Promise<AppointmentSummary | null> => {
      const { data, error } = await client
        .from("appointments")
        .select(
          "id,professional_id,service_id,starts_at,status,deposit_status,hold_expires_at,professionals!appointments_professional_id_fkey(name),services!appointments_service_id_fkey(name)",
        )
        .eq("id", appointmentId)
        .eq("contact_id", contact.id)
        .in("status", ["scheduled", "confirmed"])
        .gte("starts_at", executionNow.toISOString())
        .maybeSingle();
      if (error) throw error;
      if (!data) {
        return await durableDecision(
          `active_appointment_${appointmentId}`,
          null,
        );
      }
      if (
        data.status === "scheduled" &&
        data.deposit_status === "pending" &&
        data.hold_expires_at &&
        new Date(data.hold_expires_at as string).getTime() <=
          executionNow.getTime()
      ) {
        return await durableDecision(
          `active_appointment_${appointmentId}`,
          null,
        );
      }
      const appointment: AppointmentSummary = {
        id: data.id as string,
        professionalId: data.professional_id as string,
        professionalName: appointmentRelationName(
          data.professionals as
            | { name?: string }
            | Array<{ name?: string }>
            | null,
        ),
        serviceId: data.service_id as string,
        serviceName: appointmentRelationName(
          data.services as { name?: string } | Array<{ name?: string }> | null,
        ),
        startsAt: data.starts_at as string,
        status: data.status as "scheduled" | "confirmed",
        depositStatus:
          data.deposit_status as AppointmentSummary["depositStatus"],
        holdExpiresAt: (data.hold_expires_at as string | null) ?? null,
      };
      return await durableDecision(
        `active_appointment_${appointmentId}`,
        appointment,
      );
    };

    const showNoAppointments = async () => {
      const message =
        "No encontramos próximos turnos activos asociados a este WhatsApp.";
      await send(textPayload(message), message);
      await showMainMenu("Podés sacar un turno nuevo o hacer otra consulta.");
    };

    const showRescheduleRequest = async (
      appointment: AppointmentSummary,
      invalidAttempts = 0,
    ) => {
      const message =
        `Tu turno es:\n\n📅 ${formatDate(appointment.startsAt)}\n` +
        `🕐 ${formatTime(appointment.startsAt)}\n` +
        `${appointment.serviceName}\n\n¿Querés elegir otro horario?`;
      await send(
        buttonsPayload(message, [
          { id: "reschedule:yes", title: "Reprogramar" },
          { id: "reschedule:no", title: "Conservar turno" },
        ]),
        "¿Querés reprogramar este turno?",
      );
      await saveSession("confirming_reschedule_request", {
        appointmentId: appointment.id,
        professionalId: appointment.professionalId,
        professionalName: appointment.professionalName,
        serviceId: appointment.serviceId,
        serviceName: appointment.serviceName,
        invalidAttempts,
      });
    };

    const showCancellationRequest = async (
      appointment: AppointmentSummary,
      invalidAttempts = 0,
    ) => {
      const message =
        `Vas a cancelar este turno:\n\n📅 ${formatDate(appointment.startsAt)}\n` +
        `🕐 ${formatTime(appointment.startsAt)}\n` +
        `${appointment.serviceName}\n\n¿Confirmás la cancelación?`;
      await send(
        buttonsPayload(message, [
          { id: "cancel:yes", title: "Sí, cancelar" },
          { id: "cancel:no", title: "Conservar turno" },
        ]),
        "¿Confirmás la cancelación de este turno?",
      );
      await saveSession("confirming_cancellation", {
        appointmentId: appointment.id,
        invalidAttempts,
      });
    };

    const selectAppointmentFor = async (
      action: "reschedule" | "cancel",
      invalidAttempts = 0,
    ) => {
      const appointments = await upcomingAppointments();
      if (!appointments.length) {
        await showNoAppointments();
        return;
      }
      if (appointments.length === 1) {
        if (action === "reschedule") {
          await showRescheduleRequest(appointments[0], invalidAttempts);
        } else {
          await showCancellationRequest(appointments[0], invalidAttempts);
        }
        return;
      }
      const rows = appointments.map((appointment) => ({
        id: `turn:${action}:${appointment.id}`,
        title:
          `${compactDate(appointment.startsAt)} · ${formatTime(appointment.startsAt)}`.slice(
            0,
            24,
          ),
        description: appointment.serviceName.slice(0, 72),
      }));
      if (rows.length < 10) {
        rows.push({
          id: "flow:menu",
          title: "← Menú principal",
          description: "Volver sin hacer cambios",
        });
      }
      await send(
        listPayload(
          action === "reschedule"
            ? "¿Qué turno querés reprogramar?"
            : "¿Qué turno querés cancelar?",
          "Elegir turno",
          rows,
        ),
        action === "reschedule"
          ? "Elegí el turno que querés reprogramar."
          : "Elegí el turno que querés cancelar.",
      );
      await saveSession(
        action === "reschedule"
          ? "selecting_appointment_to_reschedule"
          : "selecting_appointment_to_cancel",
        { invalidAttempts },
      );
    };

    const showUpcomingAppointments = async (invalidAttempts = 0) => {
      const appointments = await upcomingAppointments(5);
      if (!appointments.length) {
        await showNoAppointments();
        return;
      }
      const message = [
        appointments.length === 1
          ? "Tenés este próximo turno:"
          : "Tus próximos turnos son:",
        ...appointments.map(
          (appointment, index) =>
            `\n${index + 1}. ${formatDate(appointment.startsAt)} a las ${formatTime(appointment.startsAt)}\n${appointment.serviceName}`,
        ),
        "\n¿Qué querés hacer?",
      ].join("\n");
      await send(
        buttonsPayload(message, [
          { id: "flow:reschedule", title: "Reprogramar" },
          { id: "flow:cancel", title: "Cancelar turno" },
          { id: "flow:menu", title: "Menú principal" },
        ]),
        message,
      );
      await saveSession("reviewing_appointments", { invalidAttempts });
    };

    const showClinicInfo = async (resumePrompt: string | null = null) => {
      const resumeCurrentFlow = resumePrompt !== null;
      const infoIntent =
        administrativeInfoIntent(inputValue) ?? "business_info";
      const configuredInfo =
        typeof appSettings?.general_info_message === "string"
          ? appSettings.general_info_message.trim()
          : "";
      const configuredAddress =
        typeof appSettings?.business_address === "string"
          ? appSettings.business_address.trim()
          : "";
      const businessLocation = resolveBusinessLocation(appSettings ?? {});
      const shouldSendLocation =
        infoIntent === "location" || infoIntent === "business_info";
      const locationAnswer = businessLocation
        ? conciseBusinessLocationMessage(businessLocation)
        : configuredAddress
          ? conciseBusinessLocationMessage(configuredAddress)
          : "";
      const configuredAnswer =
        infoIntent === "location"
          ? locationAnswer
          : infoIntent === "business_hours" || infoIntent === "business_info"
            ? (configuredBusinessHoursMessage(configuredInfo) ?? "")
            : configuredInfo;
      const finishInfoFlow = async () => {
        const target = informationFlowSessionTarget({
          resumeCurrentFlow,
          state: session.state,
          context: session.context,
          expiresAt: session.expires_at,
        });
        if ("expiresAt" in target) {
          await saveSessionAt(
            target.state,
            target.context ?? {},
            target.expiresAt ?? null,
          );
        } else {
          await saveSession(target.state, target.context);
        }
      };
      const sendConfiguredLocation = async () => {
        if (!shouldSendLocation || !businessLocation) return;
        const preview = `Ubicación: ${businessLocation.name}\n${businessLocation.address}`;
        await send(
          locationPayload({
            latitude: businessLocation.latitude,
            longitude: businessLocation.longitude,
            name: businessLocation.name,
            address: businessLocation.address,
          }),
          preview,
          {
            business_location: true,
            business_maps_url: businessLocation.mapsUrl,
          },
          "business_location",
        );
      };
      const sendInformationResume = async () => {
        if (!resumePrompt) return;
        const metadata = {
          information_resume: true,
          resumed_state: session.state,
        };
        const appointmentAction =
          session.state === "selecting_appointment_to_reschedule"
            ? "reschedule"
            : session.state === "selecting_appointment_to_cancel"
              ? "cancel"
              : null;
        if (appointmentAction) {
          const appointments = await upcomingAppointments();
          if (appointments.length) {
            const rows = appointments.map((appointment) => ({
              id: `turn:${appointmentAction}:${appointment.id}`,
              title:
                `${compactDate(appointment.startsAt)} · ${formatTime(appointment.startsAt)}`.slice(
                  0,
                  24,
                ),
              description: appointment.serviceName.slice(0, 72),
            }));
            await send(
              listPayload(resumePrompt, "Elegir turno", rows),
              resumePrompt,
              metadata,
            );
            return;
          }
        }
        await send(textPayload(resumePrompt), resumePrompt, metadata);
      };
      const sendInformationContinuation = async () => {
        if (resumePrompt) {
          await sendInformationResume();
        } else {
          const message = "¿Cómo querés seguir?";
          await send(
            buttonsPayload(message, [...INFORMATION_FOLLOW_UP_BUTTONS]),
            message,
            { information_follow_up: true },
          );
        }
        await finishInfoFlow();
      };
      const sendInformationAnswer = async (
        answer: string,
        metadata: Record<string, unknown> = {},
      ) => {
        if (shouldSendLocation && locationAnswer) {
          await send(textPayload(locationAnswer), locationAnswer, {
            information_location_intro: true,
          });
          await sendConfiguredLocation();
          if (infoIntent === "business_info") {
            await send(textPayload(answer), answer, metadata);
          }
        } else {
          await send(textPayload(answer), answer, metadata);
        }
        await sendInformationContinuation();
      };
      const showConfiguredInfo = async () => {
        if (!configuredAnswer) {
          await handoff(
            "Todavía no tenemos esa información configurada para responder automáticamente.",
          );
          return;
        }
        await sendInformationAnswer(configuredAnswer);
      };
      const fallbackAnswer = () =>
        configuredAnswer
          ? {
              answer: configuredAnswer,
              handoff: false,
              responseId: null,
              source: "fallback" as const,
            }
          : {
              answer: OPENAI_ADMINISTRATIVE_HANDOFF_MESSAGE,
              handoff: true,
              responseId: null,
              source: "fallback" as const,
            };

      if (
        infoIntent === "location" ||
        infoIntent === "business_info" ||
        appSettings?.ai_enabled !== true
      ) {
        await showConfiguredInfo();
        return;
      }
      const intent = infoIntent;
      if (!intent || !isAllowedAdministrativeQuestion(inputValue)) {
        await handoff(
          "Para cuidar tu privacidad, esa consulta necesita atención humana.",
        );
        return;
      }

      const readLiveAIControl = async () => {
        if (!whatsappAutomationsEnabled()) {
          return {
            automationsEnabled: false,
            aiEnabled: false,
            settings: null,
          };
        }
        const serverEnabled =
          Deno.env.get("OPENAI_ADMINISTRATIVE_ENABLED") === "true";
        if (!serverEnabled) {
          return {
            automationsEnabled: true,
            aiEnabled: false,
            settings: null,
          };
        }
        const [settingsResult, whatsappResult, hoursResult] = await Promise.all(
          [
            client
              .from("app_settings")
              .select("ai_enabled,ai_model,business_address")
              .eq("id", true)
              .single(),
            client
              .from("whatsapp_settings")
              .select("sending_paused,integration_status")
              .eq("id", true)
              .single(),
            client
              .from("availability_rules")
              .select(
                "weekday,start_time,end_time,active,professionals!inner(active)",
              )
              .eq("active", true)
              .eq("professionals.active", true)
              .order("weekday")
              .order("start_time"),
          ],
        );
        if (
          settingsResult.error ||
          whatsappResult.error ||
          hoursResult.error ||
          !settingsResult.data ||
          !whatsappResult.data ||
          whatsappResult.data.sending_paused ||
          whatsappResult.data.integration_status !== "connected"
        ) {
          console.warn("whatsapp-automation openai", {
            code: "OPENAI_CONTROL_UNAVAILABLE",
          });
          return {
            automationsEnabled: true,
            aiEnabled: false,
            settings: null,
          };
        }
        return {
          automationsEnabled: true,
          aiEnabled: administrativeOpenAIEnabled({
            globalAutomationsEnabled: true,
            serverEnabled,
            aiEnabled: settingsResult.data.ai_enabled,
            model: settingsResult.data.ai_model,
          }),
          settings: {
            ...settingsResult.data,
            business_hours: formatStructuredBusinessHours(
              hoursResult.data ?? [],
            ),
          },
        };
      };

      const beforeCall = await readLiveAIControl();
      if (!beforeCall.automationsEnabled) {
        await handoff("La respuesta automática se pausó.");
        return;
      }

      let answer: Awaited<ReturnType<typeof requestAdministrativeOpenAIAnswer>>;
      try {
        const lease = executionLease;
        if (!lease) throw new Error("AUTOMATION_EXECUTION_LEASE_LOST");
        const sequence = decisionSequence;
        decisionSequence += 1;
        answer = await resolveDurableAdministrativeAnswer({
          recall: async () => {
            const recalled = await client.rpc(
              "recall_whatsapp_automation_decision",
              {
                p_message_id: lease.messageId,
                p_lease_token: lease.leaseToken,
                p_sequence: sequence,
                p_key: "openai_administrative_answer",
              },
            );
            if (recalled.error) throw recalled.error;
            if (recalled.data === null) return null;
            const remembered = recalled.data as { value?: unknown };
            if (!("value" in remembered)) {
              throw new Error("OPENAI_DURABLE_RESPONSE_INVALID");
            }
            return remembered.value;
          },
          reserve: async () => {
            if (!beforeCall.aiEnabled) return false;
            const reservation = await client.rpc(
              "reserve_openai_administrative_request",
              {
                p_message_id: inbound.id,
                p_lease_token: lease.leaseToken,
              },
            );
            if (reservation.error) {
              throw new Error("OPENAI_QUOTA_UNAVAILABLE");
            }
            const quota = reservation.data as {
              allowed?: unknown;
              reason?: unknown;
            } | null;
            if (!quota || quota.allowed !== true) {
              const reason =
                typeof quota?.reason === "string" &&
                [
                  "ALREADY_RESERVED",
                  "CONTACT_HOURLY_LIMIT",
                  "TENANT_HOURLY_LIMIT",
                  "TENANT_DAILY_LIMIT",
                ].includes(quota.reason)
                  ? quota.reason
                  : "QUOTA_UNAVAILABLE";
              throw new Error(`OPENAI_${reason}`);
            }
            return true;
          },
          request: async () =>
            await requestAdministrativeOpenAIAnswer({
              apiKey: Deno.env.get("OPENAI_API_KEY")?.trim() ?? "",
              intent,
              knowledge: buildAdministrativeKnowledge(
                beforeCall.settings ?? {},
              ),
              safetyIdentifier: await administrativeSafetyIdentifier(
                contact.id,
              ),
            }),
          fallback: async (error) => {
            const code =
              error instanceof DOMException && error.name === "TimeoutError"
                ? "OPENAI_TIMEOUT"
                : error instanceof Error &&
                    /^OPENAI_[A-Z0-9_]+(?::[0-9]{3})?$/.test(error.message)
                  ? error.message
                  : "OPENAI_REQUEST_FAILED";
            console.warn("whatsapp-automation openai", { code });
            return fallbackAnswer();
          },
          remember: async (value) => {
            const result = await client.rpc(
              "remember_whatsapp_automation_decision",
              {
                p_message_id: lease.messageId,
                p_lease_token: lease.leaseToken,
                p_sequence: sequence,
                p_key: "openai_administrative_answer",
                p_value: { value },
              },
            );
            if (result.error) throw result.error;
            const remembered = result.data as { value?: unknown } | null;
            if (!remembered || !("value" in remembered)) {
              throw new Error("OPENAI_DURABLE_RESPONSE_INVALID");
            }
            return remembered.value;
          },
        });
      } catch {
        console.warn("whatsapp-automation openai", {
          code: "OPENAI_DURABILITY_UNAVAILABLE",
        });
        if (!whatsappAutomationsEnabled()) {
          await handoff("La respuesta automática se pausó.");
          return;
        }
        await showConfiguredInfo();
        return;
      }

      const beforeSend = await readLiveAIControl();
      if (!beforeSend.automationsEnabled) {
        await handoff("La respuesta automática se pausó.");
        return;
      }
      if (answer.source === "openai" && !beforeSend.aiEnabled) {
        await showConfiguredInfo();
        return;
      }
      if (answer.handoff) {
        await claimInboundHandoff(client, inbound.id);
        await send(
          textPayload(OPENAI_ADMINISTRATIVE_HANDOFF_MESSAGE),
          OPENAI_ADMINISTRATIVE_HANDOFF_MESSAGE,
          {
            ai_administrative: answer.source === "openai",
            ai_fallback: answer.source === "fallback",
            human_handoff: true,
            openai_response_id: answer.responseId,
          },
          "handoff",
        );
        await saveSession("human_handoff");
        return;
      }
      await sendInformationAnswer(answer.answer, {
        ai_administrative: answer.source === "openai",
        ai_fallback: answer.source === "fallback",
        openai_response_id: answer.responseId,
      });
    };

    const showAppointmentConfirmation = async (
      slot: AutomationSlot,
      invalidAttempts = 0,
    ) => {
      const message =
        `Revisá los datos antes de pre-reservar:\n\n${slot.serviceName}\n` +
        `📅 ${formatDate(slot.startsAt)}\n` +
        `🕐 ${formatTime(slot.startsAt)}\n\n` +
        "⚠️ Este horario todavía no está reservado.\n" +
        "Tocá “Pre-reservar” para guardarlo mientras enviás la seña.";
      await send(
        buttonsPayload(message, [
          { id: "appointment:confirm", title: "Pre-reservar" },
          { id: "appointment:other", title: "Cambiar horario" },
          { id: "appointment:cancel", title: "Salir sin reservar" },
        ]),
        "Este horario todavía no está reservado.",
      );
      await saveSession("confirming_appointment", {
        professionalId: session.context.professionalId,
        professionalName: session.context.professionalName,
        serviceId: slot.serviceId,
        serviceName: slot.serviceName,
        slots: [slot],
        invalidAttempts,
      });
    };

    const showRescheduleConfirmation = async (
      slot: AutomationSlot,
      appointment: AppointmentSummary,
      invalidAttempts = 0,
    ) => {
      const message =
        `Revisá el cambio antes de reprogramar:\n\n` +
        `Turno actual:\n${appointment.serviceName}\n` +
        `📅 ${formatDate(appointment.startsAt)}\n` +
        `🕐 ${formatTime(appointment.startsAt)}\n\n` +
        `Nuevo horario:\n` +
        `📅 ${formatDate(slot.startsAt)}\n` +
        `🕐 ${formatTime(slot.startsAt)}\n\n` +
        "⚠️ Tu turno actual todavía no fue modificado.\n" +
        "Tocá “Reprogramar ahora” para finalizar.";
      await send(
        buttonsPayload(message, [
          { id: "reschedule:confirm", title: "Reprogramar ahora" },
          { id: "reschedule:other", title: "Cambiar horario" },
          { id: "reschedule:back", title: "Conservar turno" },
        ]),
        "Tu turno actual todavía no fue modificado.",
      );
      await saveSession("confirming_new_slot", {
        appointmentId: appointment.id,
        professionalId: session.context.professionalId,
        professionalName: session.context.professionalName,
        serviceId: slot.serviceId,
        serviceName: slot.serviceName,
        slots: [slot],
        invalidAttempts,
      });
    };

    const handleMainIntent = async (
      intent: MainMenuIntent,
      requestedService: { id: string; name: string } | null = null,
    ) => {
      if (intent === "new") await startNewAppointmentFlow(requestedService);
      else if (intent === "reschedule") {
        if (await askForMissingProfile(0, "reschedule")) return;
        await selectAppointmentFor("reschedule");
      } else if (intent === "appointments") await showUpcomingAppointments();
      else if (intent === "cancel") await selectAppointmentFor("cancel");
      else if (intent === "info") await showClinicInfo();
      else await handoff();
    };

    if (inputValue.startsWith("reminder:")) {
      const [, action, appointmentId] = inputValue.split(":");
      const appointment = appointmentId
        ? await activeAppointmentById(appointmentId)
        : null;
      if (!appointment) {
        await send(
          textPayload(
            "Ese turno ya no está activo. Podés revisar tus próximos turnos desde el menú.",
          ),
          "Ese turno ya no está activo.",
        );
        await showMainMenu();
        return await finish({
          processed: true,
          state: "reminder_stale",
        });
      }
      if (action === "confirm") {
        if (appointment.status !== "confirmed") {
          await send(
            textPayload(
              "Ese turno todavía espera la seña. Enviá el comprobante como imagen o PDF. Si se leen el monto exacto y el destinatario, te confirmamos el turno.",
            ),
            "Ese turno todavía no está confirmado.",
          );
          await saveSession("waiting_deposit", {
            appointmentId: appointment.id,
          });
          return await finish({
            processed: true,
            state: "waiting_deposit",
          });
        }
        await send(
          textPayload("¡Gracias! Registramos que vas a asistir."),
          "¡Gracias! Registramos que vas a asistir.",
        );
        await saveSession("idle");
        return await finish({
          processed: true,
          state: "attendance_acknowledged",
        });
      }
      if (action === "cancel") {
        await showCancellationRequest(appointment);
        return await finish({
          processed: true,
          state: "confirming_cancellation",
        });
      }
      if (action === "reschedule") {
        await showSlots(
          appointment.professionalId,
          appointment.professionalName,
          appointment.serviceId,
          appointment.serviceName,
          "selecting_new_slot",
          { appointmentId: appointment.id },
        );
        return await finish({
          processed: true,
          state: "selecting_new_slot",
        });
      }
      await showMainMenu();
      return await finish({
        processed: true,
        state: "invalid_reminder_action",
      });
    }

    // Si el adjunto sigue siendo ilegible después de intentar leerlo, vuelve a
    // manos de una persona, que es el comportamiento de siempre.
    if (!replyId && unreadableMedia) {
      await handoff();
      return await finish({ processed: true, state: "human_handoff" });
    }

    let requestedIntent =
      resolveMainMenuIntent(inputValue) ?? administrativeInfoRoute(inputValue);
    const explicitHumanRequest =
      inputValue === "flow:human" ||
      /^(?:quiero |necesito )?(?:hablar|comunicarme) con (?:gisela|una persona|un humano|un operador)$/.test(
        normalizedInboundBody,
      );
    if (explicitHumanRequest) {
      await handoff();
      return await finish({ processed: true, state: "human_handoff" });
    }
    if (!replyId && requestsMultipleAppointments(inboundBody)) {
      await handoff(
        "Para coordinar turnos para más de una persona sin mezclar sus datos, necesitamos ayudarte personalmente.",
        session.context,
      );
      return await finish({
        processed: true,
        state: "human_handoff",
        reason: "MULTIPLE_APPOINTMENTS_REQUESTED",
      });
    }
    if (!replyId && asksAboutPrice(inboundBody)) {
      await handoff(
        "Para darte el valor correcto según la prestación y la cobertura, necesitamos revisar tu consulta.",
        session.context,
      );
      return await finish({
        processed: true,
        state: "human_handoff",
        reason: "PRICE_QUESTION",
      });
    }
    if (isMainMenuRequest(inputValue) || inputValue === "flow:menu") {
      await showMainMenu();
      return await finish({ processed: true, state: "idle" });
    }
    if (requestedIntent === "info") {
      const resumePrompt = informationFlowResumePrompt(
        session.state,
        session.context,
      );
      await showClinicInfo(resumePrompt);
      return await finish({
        processed: true,
        state: resumePrompt ? session.state : "info",
      });
    }
    if (
      session.state === "idle" &&
      !replyId &&
      isConversationGreeting(inboundBody)
    ) {
      await showMainMenu(
        freshSession && welcomeMessage
          ? welcomeMessage
          : "¡Hola! ¿En qué podemos ayudarte?",
      );
      return await finish({ processed: true, state: "idle" });
    }
    if (
      session.state === "idle" &&
      !replyId &&
      isConversationAcknowledgement(inboundBody)
    ) {
      const message = "¡De nada! Cuando necesites, escribinos por acá 😊";
      await send(textPayload(message), message);
      await saveSession("idle");
      return await finish({ processed: true, state: "idle" });
    }

    if (session.state === "collecting_patient_profile") {
      if (
        session.context.expectedProfileField === "coverage" &&
        isOtherCoverageReply(inputValue)
      ) {
        await handoff(
          "Para confirmar cómo se gestiona otra cobertura, necesitamos revisarlo con vos.",
          session.context,
        );
        return await finish({
          processed: true,
          state: "human_handoff",
          reason: "OTHER_COVERAGE",
        });
      }
      const parsed = await persistProfileInput(
        session.context.expectedProfileField ?? null,
      );
      const continuationContext = {
        serviceId: session.context.serviceId,
        serviceName: session.context.serviceName,
      };
      let requestedServiceOutcome: "shown" | "handoff" | "missing" | null =
        null;
      if (!parsed) {
        await invalid(async (attempts) => {
          await askForMissingProfile(
            attempts,
            session.context.continueAfterProfile,
            continuationContext,
          );
        });
      } else if (
        !(await askForMissingProfile(
          0,
          session.context.continueAfterProfile,
          continuationContext,
        ))
      ) {
        if (session.context.continueAfterProfile === "reschedule") {
          await selectAppointmentFor("reschedule");
        } else if (session.context.serviceId) {
          requestedServiceOutcome = await selectServiceAndShowSlots(
            session.context.serviceId,
          );
          if (requestedServiceOutcome === "missing") await showServices();
        } else {
          await showServices();
        }
      }
      return await finish({
        processed: true,
        state: missingPatientProfileFields(currentProfile()).length
          ? "collecting_patient_profile"
          : session.context.continueAfterProfile === "reschedule"
            ? "selecting_appointment_to_reschedule"
            : requestedServiceOutcome === "shown"
              ? "selecting_slot"
              : requestedServiceOutcome === "handoff"
                ? "human_handoff"
                : "selecting_service",
      });
    }

    if (!replyId && (await persistProfileInput(null, true))) {
      if (freshSession && welcomeMessage) {
        await send(textPayload(welcomeMessage), welcomeMessage);
      }
      if (!(await askForMissingProfile())) await showServices();
      return await finish({
        processed: true,
        state: missingPatientProfileFields(currentProfile()).length
          ? "collecting_patient_profile"
          : "selecting_service",
      });
    }
    if (requestedIntent === "human") {
      await handoff();
      return await finish({ processed: true, state: "human_handoff" });
    }
    const requestedService =
      !replyId &&
      (requestedIntent === "new" || requestedIntent === null) &&
      (session.state === "idle" || session.state === "reviewing_appointments")
        ? await findTypedService(inputValue)
        : null;
    if (requestedService && requestedIntent === null) requestedIntent = "new";
    if (
      requestedIntent &&
      (inputValue.startsWith("flow:") ||
        session.state === "idle" ||
        session.state === "reviewing_appointments")
    ) {
      if (freshSession && requestedIntent === "new" && welcomeMessage) {
        await send(textPayload(welcomeMessage), welcomeMessage);
      }
      await handleMainIntent(requestedIntent, requestedService);
      return await finish({
        processed: true,
        state: requestedIntent,
      });
    }

    if (session.state === "idle") {
      if (freshSession) {
        await showMainMenu(welcomeMessage ?? "¿En qué podemos ayudarte?");
      } else {
        await showMainMenu();
      }
    } else if (session.state === "selecting_service") {
      if (inputValue === "services:next") {
        await showServices((session.context.professionalPage ?? 0) + 1);
      } else if (inputValue === "services:prev") {
        await showServices((session.context.professionalPage ?? 0) - 1);
      } else {
        let serviceId = parseServiceReply(inputValue);
        if (!serviceId && !replyId) {
          serviceId = (await findTypedService(inputValue))?.id ?? null;
        }
        if (!serviceId) {
          await invalid((attempts) =>
            showServices(session.context.professionalPage ?? 0, attempts),
          );
        } else {
          const selectionResult = await selectServiceAndShowSlots(serviceId);
          if (selectionResult === "missing") {
            await invalid((attempts) =>
              showServices(session.context.professionalPage ?? 0, attempts),
            );
          }
        }
      }
    } else if (session.state === "selecting_slot") {
      if (inputValue === "nav:services") {
        await showServices();
      } else {
        const index = parseSlotSelection(
          inputValue,
          (session.context.slots ?? []).map(slotOptionLabel),
        );
        const slot =
          index === null ? undefined : session.context.slots?.[index];
        if (!slot) {
          await invalid(async (attempts) => {
            await showSlots(
              session.context.professionalId ?? "",
              session.context.professionalName ?? "Gisela Lentz",
              session.context.serviceId ?? "",
              session.context.serviceName ?? "Consulta",
              "selecting_slot",
              {},
              attempts,
            );
          });
        } else {
          await showAppointmentConfirmation(slot);
        }
      }
    } else if (session.state === "confirming_appointment") {
      const action = resolveAppointmentConfirmation(inputValue);
      if (action === "menu") await showMainMenu();
      else if (action === "other") {
        await showSlots(
          session.context.professionalId ?? "",
          session.context.professionalName ?? "Gisela Lentz",
          session.context.serviceId ?? "",
          session.context.serviceName ?? "Consulta",
          "selecting_slot",
        );
      } else if (action === "confirm") {
        const slot = session.context.slots?.[0];
        if (!slot) throw new Error("AUTOMATION_CONTEXT_INVALID");
        const lease = executionLease;
        if (!lease) throw new Error("AUTOMATION_EXECUTION_LEASE_LOST");
        const { data: createdAppointment, error } = await client.rpc(
          "create_whatsapp_automation_appointment",
          {
            p_message_id: lease.messageId,
            p_lease_token: lease.leaseToken,
            p_contact_id: contact.id,
            p_professional_id: slot.professionalId,
            p_service_id: slot.serviceId,
            p_starts_at: slot.startsAt,
          },
        );
        const appointment = Array.isArray(createdAppointment)
          ? createdAppointment[0]
          : createdAppointment;
        const effectError =
          appointment && typeof appointment.error_code === "string"
            ? appointment.error_code
            : null;
        if (error || effectError) {
          if (
            effectError === "SLOT_UNAVAILABLE" ||
            error?.message.includes("SLOT_UNAVAILABLE")
          ) {
            await send(
              textPayload(
                "Ese horario acaba de ocuparse. Elegí otro disponible.",
              ),
              "Ese horario acaba de ocuparse. Elegí otro disponible.",
            );
            await showSlots(
              session.context.professionalId ?? "",
              session.context.professionalName ?? "Gisela Lentz",
              session.context.serviceId ?? "",
              session.context.serviceName ?? "Consulta",
              "selecting_slot",
            );
          } else {
            throw new Error("APPOINTMENT_CREATE_FAILED");
          }
        } else {
          const appointmentId =
            appointment && typeof appointment.id === "string"
              ? appointment.id
              : null;
          if (!appointmentId) throw new Error("APPOINTMENT_CREATE_FAILED");
          committedDomainEffect = {
            conversationId: conversation.id,
            appointmentId,
            type: "create",
          };

          if (appointment.deposit_status === "pending") {
            const template =
              typeof appSettings.deposit_request_message_template === "string"
                ? appSettings.deposit_request_message_template.trim()
                : "";
            const alias =
              typeof appointment.deposit_expected_alias === "string"
                ? appointment.deposit_expected_alias.trim()
                : "";
            const holder =
              typeof appointment.deposit_expected_holder === "string"
                ? appointment.deposit_expected_holder.trim()
                : "";
            const amount = Number(appointment.deposit_expected_amount_ars);
            const holdExpiresAt =
              typeof appointment.hold_expires_at === "string"
                ? new Date(appointment.hold_expires_at).getTime()
                : Number.NaN;
            const holdMinutes = Math.ceil(
              (holdExpiresAt - executionNow.getTime()) / 60_000,
            );
            if (
              !template ||
              !alias ||
              !holder ||
              !Number.isSafeInteger(amount) ||
              amount <= 0 ||
              !Number.isSafeInteger(holdMinutes) ||
              holdMinutes <= 0
            ) {
              await handoff(
                "El horario quedó pre-reservado, pero necesitamos que una persona te envíe los datos de la seña.",
              );
            } else {
              const message = renderConfiguredMessage(template, {
                deposit_amount: formatDepositAmountArs(amount),
                deposit_alias: alias,
                deposit_holder: holder,
              });
              if (
                !message ||
                message.length > 4096 ||
                /\{[a-z][a-z0-9_]*\}/.test(message)
              ) {
                await handoff(
                  "El horario quedó pre-reservado, pero necesitamos que una persona te envíe los datos de la seña.",
                );
                return await finish({
                  processed: true,
                  state: "human_handoff",
                });
              }
              // La reserva y su ledger se confirmaron en una sola transacción.
              // La sesión también queda secuenciada antes del efecto externo.
              await saveSession(
                "waiting_deposit",
                { appointmentId },
                holdMinutes,
              );
              const depositSendSequence = sendSequence;
              sendSequence += 1;
              try {
                const lease = executionLease;
                if (!lease) {
                  throw new Error("AUTOMATION_EXECUTION_LEASE_LOST");
                }
                await sendAndRecordMessage({
                  client,
                  conversation: conversation as WhatsAppConversation,
                  contact: contact as WhatsAppContact,
                  payload: textPayload(message),
                  bodyPreview: message,
                  idempotencyKey: `automation:${inbound.id}:${depositSendSequence}`,
                  appointmentId,
                  coexistenceAccountId: inbound.coexistence_account_id,
                  metadata: {
                    source: "deposit_request",
                    inbound_message_id: inbound.id,
                    automation_sequence: depositSendSequence,
                    appointment_id: appointmentId,
                    deposit_request: true,
                  },
                  automationExecution: lease,
                });
              } catch (error) {
                // La pre-reserva ya existe. Si el aviso no sale, la dejamos
                // visible para atención humana en lugar de permitir que el bot
                // siga como si el paciente hubiera recibido los datos.
                await claimInboundHandoff(client, inbound.id);
                await saveSession("human_handoff", { appointmentId });
                console.warn("Deposit request needs human follow-up", {
                  code: isWhatsAppPolicyError(error)
                    ? error.code
                    : "DEPOSIT_REQUEST_SEND_FAILED",
                  appointmentId,
                });
                return await finish({
                  processed: true,
                  state: "human_handoff",
                  reason: "DEPOSIT_REQUEST_SEND_FAILED",
                });
              }
            }
          } else if (
            appointment.status === "confirmed" &&
            appointment.deposit_status === "not_required"
          ) {
            const message =
              `¡Listo! Tu turno quedó confirmado.\n\n📅 ${formatDate(slot.startsAt)}\n` +
              `🕐 ${formatTime(slot.startsAt)}\n${slot.serviceName}`;
            await send(
              textPayload(message),
              "¡Listo! Tu turno quedó confirmado.",
              {
                appointment_id: appointmentId,
              },
            );
            await saveSession("idle");
          } else {
            throw new Error("APPOINTMENT_STATE_INVALID");
          }
        }
      } else {
        await invalid((attempts) => {
          const slot = session.context.slots?.[0];
          return slot
            ? showAppointmentConfirmation(slot, attempts)
            : showMainMenu();
        });
      }
    } else if (session.state === "selecting_appointment_to_reschedule") {
      const appointmentId = parseAppointmentSelection(inputValue, "reschedule");
      const appointment = appointmentId
        ? await activeAppointmentById(appointmentId)
        : null;
      if (!appointment) {
        await invalid((attempts) =>
          selectAppointmentFor("reschedule", attempts),
        );
      } else {
        await showRescheduleRequest(appointment);
      }
    } else if (session.state === "confirming_reschedule_request") {
      const action = resolveRescheduleRequest(inputValue);
      if (action === "no") await showMainMenu("Tu turno queda sin cambios.");
      else if (action === "yes") {
        const appointmentId = session.context.appointmentId;
        const appointment = appointmentId
          ? await activeAppointmentById(appointmentId)
          : null;
        if (!appointment) await showNoAppointments();
        else {
          await showSlots(
            appointment.professionalId,
            appointment.professionalName,
            appointment.serviceId,
            appointment.serviceName,
            "selecting_new_slot",
            { appointmentId: appointment.id },
          );
        }
      } else {
        await invalid(async (attempts) => {
          const appointment = session.context.appointmentId
            ? await activeAppointmentById(session.context.appointmentId)
            : null;
          if (appointment) await showRescheduleRequest(appointment, attempts);
          else await showNoAppointments();
        });
      }
    } else if (session.state === "selecting_new_slot") {
      if (inputValue === "reschedule:back") {
        await showMainMenu("Tu turno queda sin cambios.");
      } else {
        const index = parseSlotSelection(
          inputValue,
          (session.context.slots ?? []).map(slotOptionLabel),
        );
        const slot =
          index === null ? undefined : session.context.slots?.[index];
        if (!slot) {
          await invalid(async (attempts) => {
            await showSlots(
              session.context.professionalId ?? "",
              session.context.professionalName ?? "Gisela Lentz",
              session.context.serviceId ?? "",
              session.context.serviceName ?? "Consulta",
              "selecting_new_slot",
              { appointmentId: session.context.appointmentId },
              attempts,
            );
          });
        } else {
          const appointment = session.context.appointmentId
            ? await activeAppointmentById(session.context.appointmentId)
            : null;
          if (appointment) await showRescheduleConfirmation(slot, appointment);
          else await showNoAppointments();
        }
      }
    } else if (session.state === "confirming_new_slot") {
      const action = resolveRescheduleConfirmation(inputValue);
      if (action === "back") {
        await showMainMenu("Tu turno queda sin cambios.");
      } else if (action === "other") {
        await showSlots(
          session.context.professionalId ?? "",
          session.context.professionalName ?? "Gisela Lentz",
          session.context.serviceId ?? "",
          session.context.serviceName ?? "Consulta",
          "selecting_new_slot",
          { appointmentId: session.context.appointmentId },
        );
      } else if (action === "confirm") {
        const slot = session.context.slots?.[0];
        const appointmentId = session.context.appointmentId;
        if (!slot || !appointmentId) {
          await showNoAppointments();
        } else {
          const lease = executionLease;
          if (!lease) throw new Error("AUTOMATION_EXECUTION_LEASE_LOST");
          const { data: rescheduleResult, error } = await client.rpc(
            "reschedule_whatsapp_automation_appointment",
            {
              p_message_id: lease.messageId,
              p_lease_token: lease.leaseToken,
              p_appointment_id: appointmentId,
              p_starts_at: slot.startsAt,
            },
          );
          const effectError =
            rescheduleResult &&
            !Array.isArray(rescheduleResult) &&
            typeof rescheduleResult.error_code === "string"
              ? rescheduleResult.error_code
              : null;
          if (
            effectError === "APPOINTMENT_NOT_FOUND" ||
            error?.message.includes("APPOINTMENT_NOT_FOUND")
          ) {
            await showNoAppointments();
          } else if (
            effectError === "SLOT_UNAVAILABLE" ||
            error?.message.includes("SLOT_UNAVAILABLE")
          ) {
            await send(
              textPayload(
                "Ese horario acaba de ocuparse. Tu turno original sigue reservado; elegí otra opción.",
              ),
              "Ese horario acaba de ocuparse.",
            );
            await showSlots(
              session.context.professionalId ?? "",
              session.context.professionalName ?? "Gisela Lentz",
              session.context.serviceId ?? "",
              session.context.serviceName ?? "Consulta",
              "selecting_new_slot",
              { appointmentId },
            );
          } else if (error) {
            throw error;
          } else {
            committedDomainEffect = {
              conversationId: conversation.id,
              appointmentId,
              type: "reschedule",
            };
            const rescheduledAppointment =
              rescheduleResult &&
              !Array.isArray(rescheduleResult) &&
              typeof rescheduleResult === "object"
                ? (rescheduleResult as Record<string, unknown>)
                : null;
            const depositStatus =
              typeof rescheduledAppointment?.deposit_status === "string"
                ? rescheduledAppointment.deposit_status
                : null;
            const holdExpiresAt =
              typeof rescheduledAppointment?.hold_expires_at === "string"
                ? rescheduledAppointment.hold_expires_at
                : null;
            const waitingForDeposit =
              depositStatus === "pending" &&
              holdExpiresAt !== null &&
              Number.isFinite(new Date(holdExpiresAt).getTime());
            const message =
              `¡Listo! Tu turno quedó reprogramado.\n\n📅 ${formatDate(slot.startsAt)}\n` +
              `🕐 ${formatTime(slot.startsAt)}\n${slot.serviceName}` +
              (waitingForDeposit
                ? "\n\nLa pre-reserva sigue esperando la seña. Enviá el comprobante como imagen o PDF. Si se leen el monto exacto y el destinatario, te confirmamos el turno."
                : "");
            await send(textPayload(message), "Tu turno quedó reprogramado.", {
              appointment_id: appointmentId,
            });
            if (waitingForDeposit) {
              const remainingMinutes = Math.max(
                1,
                Math.ceil(
                  (new Date(holdExpiresAt).getTime() - executionNow.getTime()) /
                    60_000,
                ),
              );
              await saveSession(
                "waiting_deposit",
                { appointmentId },
                remainingMinutes,
              );
            } else {
              await saveSession("idle");
            }
          }
        }
      } else {
        await invalid(async (attempts) => {
          const slot = session.context.slots?.[0];
          const appointment = session.context.appointmentId
            ? await activeAppointmentById(session.context.appointmentId)
            : null;
          if (slot && appointment) {
            await showRescheduleConfirmation(slot, appointment, attempts);
          } else {
            await showMainMenu();
          }
        });
      }
    } else if (session.state === "selecting_appointment_to_cancel") {
      const appointmentId = parseAppointmentSelection(inputValue, "cancel");
      const appointment = appointmentId
        ? await activeAppointmentById(appointmentId)
        : null;
      if (!appointment) {
        await invalid((attempts) => selectAppointmentFor("cancel", attempts));
      } else {
        await showCancellationRequest(appointment);
      }
    } else if (session.state === "confirming_cancellation") {
      const action = resolveCancellationConfirmation(inputValue);
      if (action === "no") {
        await showMainMenu("Tu turno queda sin cambios.");
      } else if (action === "yes") {
        const appointmentId = session.context.appointmentId;
        if (!appointmentId) await showNoAppointments();
        else {
          const lease = executionLease;
          if (!lease) throw new Error("AUTOMATION_EXECUTION_LEASE_LOST");
          const { data: cancelResult, error } = await client.rpc(
            "cancel_whatsapp_automation_appointment",
            {
              p_message_id: lease.messageId,
              p_lease_token: lease.leaseToken,
              p_appointment_id: appointmentId,
            },
          );
          const effectError =
            cancelResult &&
            !Array.isArray(cancelResult) &&
            typeof cancelResult.error_code === "string"
              ? cancelResult.error_code
              : null;
          if (
            effectError === "APPOINTMENT_NOT_FOUND" ||
            error?.message.includes("APPOINTMENT_NOT_FOUND")
          ) {
            await showNoAppointments();
          } else if (error) {
            throw error;
          } else {
            committedDomainEffect = {
              conversationId: conversation.id,
              appointmentId,
              type: "cancel",
            };
            await send(
              textPayload(
                "Tu turno quedó cancelado. Si necesitás uno nuevo, podés solicitarlo desde este chat.",
              ),
              "Tu turno quedó cancelado.",
            );
            await saveSession("idle");
          }
        }
      } else {
        await invalid(async (attempts) => {
          const appointment = session.context.appointmentId
            ? await activeAppointmentById(session.context.appointmentId)
            : null;
          if (appointment) await showCancellationRequest(appointment, attempts);
          else await showNoAppointments();
        });
      }
    } else if (session.state === "reviewing_appointments") {
      await invalid((attempts) => showUpcomingAppointments(attempts));
    } else if (session.state === "waiting_deposit") {
      const appointment = session.context.appointmentId
        ? await activeAppointmentById(session.context.appointmentId)
        : null;
      if (
        appointment?.status === "confirmed" ||
        appointment?.depositStatus === "confirmed"
      ) {
        const message = "Tu turno ya está confirmado.";
        await send(textPayload(message), message, {
          appointment_id: appointment.id,
        });
        await saveSession("idle");
      } else if (!appointment || appointment.status !== "scheduled") {
        await showMainMenu(
          "Esa pre-reserva ya no está activa. Si querés, podemos buscarte otro horario.",
        );
      } else if (inputValue === "deposit:cancel") {
        await showCancellationRequest(appointment);
      } else {
        const remainingMinutes = appointment.holdExpiresAt
          ? Math.max(
              1,
              Math.ceil(
                (new Date(appointment.holdExpiresAt).getTime() -
                  executionNow.getTime()) /
                  60_000,
              ),
            )
          : 30;
        const acknowledgement =
          inputValue === "deposit:ack" ||
          (!replyId && isConversationAcknowledgement(inboundBody));
        if (acknowledgement) {
          if (session.context.depositAcknowledged !== true) {
            const message =
              appointment.depositStatus === "proof_received"
                ? "¡Gracias! Ya recibimos el comprobante y está pendiente de revisión."
                : "Perfecto, quedamos atentos al comprobante 😊";
            await send(textPayload(message), message, {
              appointment_id: appointment.id,
            });
          }
          await saveSession(
            "waiting_deposit",
            {
              ...session.context,
              depositAcknowledged: true,
            },
            remainingMinutes,
          );
        } else if (session.context.depositHelpShown === true) {
          await handoff(
            "Vemos que necesitás ayuda antes de completar la seña.",
            session.context,
          );
        } else {
          const message =
            appointment.depositStatus === "proof_received"
              ? "Ya recibimos tu comprobante y quedó pendiente de revisión. Si necesitás consultar algo, elegí “Hablar con la secretaria”."
              : "Tu horario sigue pre-reservado. Para confirmarlo, enviá el comprobante como imagen o PDF. Si necesitás ayuda antes de pagar, elegí una opción.";
          await send(
            buttonsPayload(message, [
              { id: "deposit:ack", title: "Ya lo envío" },
              { id: SECRETARY_REPLY_ID, title: "Secretaria" },
              { id: "deposit:cancel", title: "Cancelar reserva" },
            ]),
            message,
            { appointment_id: appointment.id },
          );
          await saveSession(
            "waiting_deposit",
            {
              ...session.context,
              depositHelpShown: true,
            },
            remainingMinutes,
          );
        }
      }
    } else {
      await showMainMenu();
    }

    return await finish({ processed: true });
  } catch (error) {
    const policyCode = whatsAppPolicyCode(error);
    if (policyCode) {
      console.warn("whatsapp-automation blocked", policyCode);
      if (
        committedDomainEffect &&
        executionLease &&
        policyCode !== "AUTOMATION_PAUSED"
      ) {
        const lease = executionLease;
        const domainEffect = committedDomainEffect;
        try {
          const outcome = await handoffCommittedExecution(
            client,
            lease,
            domainEffect,
            `POST_${domainEffect.type.toUpperCase()}_${policyCode}`,
          );
          await completeExecution(client, lease, outcome);
          executionLease = null;
          return jsonResponse(request, outcome);
        } catch (handoffError) {
          if (whatsAppPolicyCode(handoffError) === "AUTOMATION_PAUSED") {
            const outcome = {
              processed: false,
              blocked: true,
              reason: "AUTOMATION_PAUSED",
            };
            try {
              await completeExecution(client, lease, outcome);
              executionLease = null;
              return jsonResponse(request, outcome);
            } catch (completionError) {
              await failExecution(client, lease, completionError);
              console.error(
                "whatsapp-automation",
                safeErrorMessage(completionError),
              );
              return jsonResponse(request, { error: "AUTOMATION_FAILED" }, 500);
            }
          }
          await failExecution(client, lease, handoffError);
          console.error("whatsapp-automation", safeErrorMessage(handoffError));
          return jsonResponse(request, { error: "AUTOMATION_FAILED" }, 500);
        }
      }
      const outcome = {
        processed: false,
        blocked: true,
        reason: policyCode,
      };
      if (executionLease) {
        const lease = executionLease;
        try {
          await completeExecution(client, lease, outcome);
          executionLease = null;
        } catch (completionError) {
          await failExecution(client, lease, completionError);
          console.error(
            "whatsapp-automation",
            safeErrorMessage(completionError),
          );
          return jsonResponse(request, { error: "AUTOMATION_FAILED" }, 500);
        }
      }
      return jsonResponse(request, outcome);
    }
    if (executionLease) await failExecution(client, executionLease, error);
    console.error("whatsapp-automation", safeErrorMessage(error));
    return jsonResponse(request, { error: "AUTOMATION_FAILED" }, 500);
  }
});
