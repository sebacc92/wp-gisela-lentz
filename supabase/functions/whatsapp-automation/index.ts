import {
  MAIN_MENU_OPTIONS,
  formatDepositAmountArs,
  isMainMenuRequest,
  missingPatientProfileFields,
  nextInvalidAttempt,
  normalizeUserInput,
  parseAppointmentSelection,
  parsePatientProfileReply,
  parseServiceReply,
  parseSlotIndex,
  renderConfiguredMessage,
  resolveAppointmentConfirmation,
  resolveCancellationConfirmation,
  resolveMainMenuIntent,
  resolveRescheduleConfirmation,
  resolveRescheduleRequest,
  type MainMenuIntent,
  type PatientCoverage,
  type PatientProfileField,
} from "../_shared/automation-flow.ts";
import {
  jsonResponse,
  optionsResponse,
  safeErrorMessage,
} from "../_shared/http.ts";
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
  requestAudioTranscription,
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

interface InboundSnapshot {
  id: string;
  conversation_id: string;
  contact_id: string;
  coexistence_account_id: string | null;
  body: string | null;
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
  automation_welcome_message?: string | null;
  urgent_message?: string | null;
  general_info_message?: string | null;
  ai_enabled?: boolean;
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

interface AutomationExecutionLease {
  messageId: string;
  leaseToken: string;
}

interface CommittedAutomationDomainEffect {
  conversationId: string;
  appointmentId: string;
  type: "create" | "reschedule" | "cancel";
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
): Promise<void> {
  const result = await client.rpc(
    "pause_whatsapp_automation_for_inbound_handoff",
    {
      p_message_id: messageId,
      p_priority: false,
      p_current_flow: null,
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
  continueAfterProfile?: "services" | "reschedule";
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
        "id,conversation_id,contact_id,coexistence_account_id,body,direction,metadata",
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
    if (
      priorEffect?.appointment_id &&
      priorEffect.result?.effect_status !== "rejected"
    ) {
      const type =
        priorEffect.effect_type === "appointment_create"
          ? "create"
          : priorEffect.effect_type === "appointment_reschedule"
            ? "reschedule"
            : "cancel";
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

    // Una nota de voz llega con el cuerpo "Nota de voz": para el bot es opaca.
    // Si la transcripción está habilitada, el texto dicho reemplaza ese cuerpo
    // y el resto del flujo lo trata como si el paciente lo hubiera escrito.
    if (
      inbound.type === "audio" &&
      mediaOpenAIEnabled({
        globalAutomationsEnabled: whatsappAutomationsEnabled(),
        serverEnabled:
          Deno.env.get("OPENAI_ADMINISTRATIVE_ENABLED")?.trim() === "true",
        aiEnabled: appSettings?.ai_enabled,
        aiMediaEnabled: appSettings?.ai_media_enabled,
        model: appSettings?.ai_model,
      })
    ) {
      try {
        const media = await downloadInboundWhatsAppMedia({
          client,
          message: inbound as Record<string, unknown>,
          fetchImpl: fetch,
          maxBytes: whatsappMediaMaxBytes(
            Deno.env.get("WHATSAPP_MEDIA_MAX_BYTES"),
          ),
        });
        const transcription = await requestAudioTranscription({
          apiKey: Deno.env.get("OPENAI_API_KEY") ?? "",
          bytes: media.bytes,
          mimeType: media.descriptor.mimeType,
          safetyIdentifier: await administrativeSafetyIdentifier(
            contact.id as string,
          ),
        });
        if (transcription.audible) {
          inboundBody = transcription.transcript;
          await client
            .from("messages")
            .update({
              metadata: {
                ...((inbound.metadata ?? {}) as Record<string, unknown>),
                transcript: transcription.transcript,
              },
            })
            .eq("id", inbound.id);
        }
      } catch (error) {
        // Una transcripción fallida no interrumpe la conversación: el audio
        // sigue su camino como adjunto que una persona tiene que escuchar.
        console.warn("whatsapp-automation", "AUDIO_TRANSCRIPTION_FAILED", {
          code: error instanceof Error ? error.message : "UNKNOWN",
        });
      }
    }

    const normalizedInboundBody = normalizeUserInput(inboundBody);
    const inputValue = replyId || inboundBody;
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

    sessionWriteSequence = 0;
    const saveSession = async (
      state: string,
      context: AutomationContext = {},
      ttlMinutes = 30,
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
        p_expires_at: new Date(
          executionNow.getTime() + Math.max(1, ttlMinutes) * 60 * 1000,
        ).toISOString(),
      });
      if (result.error) throw result.error;
    };

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
    ) => {
      const sequence = sendSequence;
      sendSequence += 1;
      return await sendAndRecordMessage({
        client,
        conversation: conversation as WhatsAppConversation,
        contact: contact as WhatsAppContact,
        payload,
        bodyPreview,
        idempotencyKey: `automation:${inbound.id}:${sequence}`,
        coexistenceAccountId: inbound.coexistence_account_id,
        metadata: {
          ...extraMetadata,
          source,
          inbound_message_id: inbound.id,
          automation_sequence: sequence,
        },
      });
    };

    const currentProfile = () => ({
      name: typeof contact.name === "string" ? contact.name : null,
      isExistingPatient:
        typeof contact.is_existing_patient === "boolean"
          ? contact.is_existing_patient
          : null,
      coverage:
        contact.coverage === "ioma" || contact.coverage === "particular"
          ? (contact.coverage as PatientCoverage)
          : null,
    });

    const persistProfileInput = async (
      expectedField: PatientProfileField | null = null,
      requireStructuredReply = false,
    ): Promise<boolean> => {
      const parsed = parsePatientProfileReply(inputValue, {
        expectedField,
        primaryPhoneE164:
          typeof contact.phone_e164 === "string" ? contact.phone_e164 : null,
      });
      const structuredFieldCount = [
        parsed.values.name,
        parsed.values.isExistingPatient,
        parsed.values.coverage,
      ].filter((field) => field !== undefined).length;
      if (requireStructuredReply && structuredFieldCount < 2) return false;
      const updates: Record<string, unknown> = {};
      if (parsed.values.name) updates.name = parsed.values.name;
      if (typeof parsed.values.isExistingPatient === "boolean") {
        updates.is_existing_patient = parsed.values.isExistingPatient;
      }
      if (parsed.values.coverage) updates.coverage = parsed.values.coverage;
      if (parsed.values.alternatePhoneE164) {
        updates.alternate_phone_e164 = parsed.values.alternatePhoneE164;
      }
      if (!Object.keys(updates).length) return false;

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
    ): Promise<boolean> => {
      const missing = missingPatientProfileFields(currentProfile());
      const field = missing[0];
      if (!field) return false;

      if (field === "name") {
        const message = "Para agendar, ¿cuál es tu nombre y apellido?";
        await send(textPayload(message), message);
      } else if (field === "is_existing_patient") {
        const message = "¿Ya te atendiste conmigo antes?";
        await send(
          buttonsPayload(message, [
            { id: "profile:existing:yes", title: "Sí" },
            { id: "profile:existing:no", title: "No" },
          ]),
          message,
        );
      } else {
        const message = "¿Tu cobertura es IOMA o Particular?";
        await send(
          buttonsPayload(message, [
            { id: "profile:coverage:ioma", title: "IOMA" },
            { id: "profile:coverage:particular", title: "Particular" },
          ]),
          message,
        );
      }

      await saveSession(
        "collecting_patient_profile",
        {
          expectedProfileField: field,
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

    if (conversation.priority === true) {
      const urgentMessage =
        typeof appSettings?.urgent_message === "string" &&
        appSettings.urgent_message.trim()
          ? appSettings.urgent_message.trim()
          : "Tomo tu mensaje como urgencia y te respondo apenas lo vea. Si es una emergencia grave, contactá al servicio de emergencias de tu zona.";
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

    if (conversation.automation_mode !== "auto") {
      return await finish({ ignored: true });
    }

    if (!freshSession && session.state === "out_of_hours") {
      return await finish({
        processed: false,
        ignored: true,
        reason: "OUT_OF_HOURS_COOLDOWN",
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

    const showMainMenu = async (message = "¿En qué más te puedo ayudar?") => {
      await send(
        listPayload(message, "Ver opciones", MAIN_MENU_OPTIONS),
        message,
      );
      await saveSession("idle");
    };

    const handoff = async (reason = "") => {
      await claimInboundHandoff(client, inbound.id);
      const handoffMessage =
        `${reason ? `${reason.trim()} ` : ""}` +
        "Sigo yo desde acá. Te respondo por este mismo chat.";
      await send(
        textPayload(handoffMessage),
        handoffMessage,
        { human_handoff: true },
        "handoff",
      );
      await saveSession("human_handoff");
    };

    const invalid = async (repeat: (attempts: number) => Promise<void>) => {
      const { attempts, shouldHandoff } = nextInvalidAttempt(
        session.context.invalidAttempts,
      );
      if (shouldHandoff) {
        await handoff("No pude interpretar la opción.");
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
        await handoff("Todavía no hay servicios disponibles para reservar.");
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

    const startNewAppointmentFlow = async () => {
      if (await askForMissingProfile(0, "services")) return;
      await showServices();
    };

    const findSlots = async (
      professionalId: string,
      professionalName: string,
      serviceId: string,
      serviceName: string,
      coverage: PatientCoverage,
      limit = 8,
    ): Promise<AutomationSlot[]> => {
      const slots: AutomationSlot[] = [];
      for (let offset = 0; offset < 21 && slots.length < limit; offset += 1) {
        const date = new Date(executionNow);
        date.setDate(date.getDate() + offset);
        const { data, error } = await client.rpc(
          "get_available_slots_for_coverage",
          {
            p_professional_id: professionalId,
            p_coverage: coverage,
            p_date: dateInTimezone(date, businessTimezone),
            p_timezone: businessTimezone,
            p_limit: limit - slots.length,
          },
        );
        if (error) throw error;
        for (const slot of data ?? []) {
          slots.push({
            startsAt: slot.starts_at,
            endsAt: slot.ends_at,
            professionalId,
            professionalName,
            serviceId,
            serviceName,
          });
          if (slots.length >= limit) break;
        }
      }
      return await durableDecision("available_slots", slots);
    };

    const showSlots = async (
      professionalId: string,
      professionalName: string,
      serviceId: string,
      serviceName: string,
      state: "selecting_slot" | "selecting_new_slot",
      context: AutomationContext = {},
      invalidAttempts = 0,
    ) => {
      const slotCoverage = currentProfile().coverage;
      if (!slotCoverage) {
        await handoff(
          "Necesitamos revisar la cobertura de este turno antes de reprogramarlo.",
        );
        return;
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
        return;
      }
      const rows: Array<{ id: string; title: string; description?: string }> =
        slots.map((slot, index) => ({
          id: `slot:${index}`,
          title:
            `${compactDate(slot.startsAt)} · ${formatTime(slot.startsAt)}`.slice(
              0,
              24,
            ),
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
      await showMainMenu("Podés sacar un turno nuevo o hacerme otra consulta.");
    };

    const showRescheduleRequest = async (
      appointment: AppointmentSummary,
      invalidAttempts = 0,
    ) => {
      const message =
        `Tu turno es:\n\n📅 ${formatDate(appointment.startsAt)}\n` +
        `🕐 ${formatTime(appointment.startsAt)}\n` +
        `${appointment.serviceName} · ${appointment.professionalName}\n\n¿Querés elegir otro horario?`;
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
        `${appointment.serviceName} · ${appointment.professionalName}\n\n¿Confirmás la cancelación?`;
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
            `\n${index + 1}. ${formatDate(appointment.startsAt)} a las ${formatTime(appointment.startsAt)}\n${appointment.serviceName} · ${appointment.professionalName}`,
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

    const showClinicInfo = async () => {
      const configuredInfo =
        typeof appSettings?.general_info_message === "string"
          ? appSettings.general_info_message.trim()
          : "";
      const showConfiguredInfo = async () => {
        if (!configuredInfo) {
          await handoff(
            "Todavía no tenemos esa información configurada para responder automáticamente.",
          );
          return;
        }
        await send(
          buttonsPayload(configuredInfo, [
            { id: "flow:new", title: "Sacar un turno" },
            { id: "flow:human", title: "Otra consulta" },
            { id: "flow:menu", title: "Menú principal" },
          ]),
          configuredInfo,
        );
        await saveSession("idle");
      };
      const fallbackAnswer = () =>
        configuredInfo
          ? {
              answer: configuredInfo,
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

      if (appSettings?.ai_enabled !== true) {
        await showConfiguredInfo();
        return;
      }
      const intent = administrativeInfoIntent(inputValue);
      if (!intent || !isAllowedAdministrativeQuestion(inputValue)) {
        await handoff(
          "Para cuidar tu privacidad, esa consulta la reviso yo personalmente.",
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
      if (!beforeCall.automationsEnabled) return;

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
        return;
      }

      const beforeSend = await readLiveAIControl();
      if (!beforeSend.automationsEnabled) return;
      if (answer.source === "openai" && !beforeSend.aiEnabled) return;
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
      await send(
        buttonsPayload(answer.answer, [
          { id: "flow:new", title: "Sacar un turno" },
          { id: "flow:human", title: "Otra consulta" },
          { id: "flow:menu", title: "Menú principal" },
        ]),
        answer.answer,
        {
          ai_administrative: answer.source === "openai",
          ai_fallback: answer.source === "fallback",
          openai_response_id: answer.responseId,
        },
      );
      await saveSession("idle");
    };

    const showAppointmentConfirmation = async (
      slot: AutomationSlot,
      invalidAttempts = 0,
    ) => {
      const message =
        `Revisá los datos antes de pre-reservar:\n\n${slot.serviceName}\n${slot.professionalName}\n` +
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
        `Turno actual:\n${appointment.serviceName} · ${appointment.professionalName}\n` +
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

    const handleMainIntent = async (intent: MainMenuIntent) => {
      if (intent === "new") await startNewAppointmentFlow();
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
              "Ese turno todavía no está confirmado. Reviso la seña antes de confirmarlo.",
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
          textPayload("¡Gracias! Anotamos que vas a asistir."),
          "¡Gracias! Anotamos que vas a asistir.",
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

    // El saludo va siempre primero, antes de pedir cualquier dato: si el primer
    // mensaje ya pedía un turno, el flujo arrancaba sin saludar.
    if (freshSession && welcomeMessage) {
      await send(textPayload(welcomeMessage), welcomeMessage);
    }

    const requestedIntent =
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
    if (isMainMenuRequest(inputValue) || inputValue === "flow:menu") {
      await showMainMenu();
      return await finish({ processed: true, state: "idle" });
    }

    if (session.state === "collecting_patient_profile") {
      const parsed = await persistProfileInput(
        session.context.expectedProfileField ?? null,
      );
      if (!parsed) {
        await invalid(async (attempts) => {
          await askForMissingProfile(
            attempts,
            session.context.continueAfterProfile,
          );
        });
      } else if (
        !(await askForMissingProfile(0, session.context.continueAfterProfile))
      ) {
        if (session.context.continueAfterProfile === "reschedule") {
          await selectAppointmentFor("reschedule");
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
            : "selecting_service",
      });
    }

    if (!replyId && (await persistProfileInput(null, true))) {
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
    if (
      requestedIntent &&
      (inputValue.startsWith("flow:") ||
        session.state === "idle" ||
        session.state === "reviewing_appointments")
    ) {
      await handleMainIntent(requestedIntent);
      return await finish({
        processed: true,
        state: requestedIntent,
      });
    }

    if (session.state === "idle") {
      // El saludo ya salió como mensaje aparte; acá va sólo el pedido.
      await showMainMenu(freshSession ? "Elegí una opción:" : undefined);
    } else if (session.state === "selecting_service") {
      if (inputValue === "services:next") {
        await showServices((session.context.professionalPage ?? 0) + 1);
      } else if (inputValue === "services:prev") {
        await showServices((session.context.professionalPage ?? 0) - 1);
      } else {
        let serviceId = parseServiceReply(inputValue);
        if (!serviceId && !replyId) {
          const { data: services, error } = await client
            .from("services")
            .select("id,name")
            .eq("active", true);
          if (error) throw error;
          const serviceOptions = await durableDecision(
            "typed_service_options",
            services ?? [],
          );
          const typedService = serviceOptions.find(
            (service) =>
              normalizeUserInput(service.name as string) ===
              normalizedInboundBody,
          );
          serviceId = typedService?.id as string | null;
        }
        if (!serviceId) {
          await invalid((attempts) =>
            showServices(session.context.professionalPage ?? 0, attempts),
          );
        } else {
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
            await invalid((attempts) =>
              showServices(session.context.professionalPage ?? 0, attempts),
            );
          } else {
            await showSlots(
              selection.professional.id as string,
              selection.professional.name as string,
              selection.service.id as string,
              selection.service.name as string,
              "selecting_slot",
            );
          }
        }
      }
    } else if (session.state === "selecting_slot") {
      if (inputValue === "nav:services") {
        await showServices();
      } else {
        const index = parseSlotIndex(
          inputValue,
          session.context.slots?.length ?? 0,
        );
        const slot =
          index === null ? undefined : session.context.slots?.[index];
        if (!slot) {
          await invalid((attempts) =>
            showSlots(
              session.context.professionalId ?? "",
              session.context.professionalName ?? "Gisela Lentz",
              session.context.serviceId ?? "",
              session.context.serviceName ?? "Consulta",
              "selecting_slot",
              {},
              attempts,
            ),
          );
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
              typeof appSettings.deposit_alias === "string"
                ? appSettings.deposit_alias.trim()
                : "";
            const holder =
              typeof appSettings.deposit_holder === "string"
                ? appSettings.deposit_holder.trim()
                : "";
            const amount = Number(appSettings.deposit_amount_ars);
            const holdMinutes = Number(appSettings.booking_hold_minutes);
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
                "El horario quedó pre-reservado, pero necesitamos enviarte los datos de la seña personalmente.",
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
                  "El horario quedó pre-reservado, pero necesitamos enviarte los datos de la seña personalmente.",
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
              `¡Listo! Tu turno quedó agendado.\n\n📅 ${formatDate(slot.startsAt)}\n` +
              `🕐 ${formatTime(slot.startsAt)}\n${slot.serviceName} · ${slot.professionalName}`;
            await send(
              textPayload(message),
              "¡Listo! Tu turno quedó agendado.",
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
      if (action === "no")
        await showMainMenu("Conservamos tu turno sin cambios.");
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
        await showMainMenu("Conservamos tu turno sin cambios.");
      } else {
        const index = parseSlotIndex(
          inputValue,
          session.context.slots?.length ?? 0,
        );
        const slot =
          index === null ? undefined : session.context.slots?.[index];
        if (!slot) {
          await invalid((attempts) =>
            showSlots(
              session.context.professionalId ?? "",
              session.context.professionalName ?? "Gisela Lentz",
              session.context.serviceId ?? "",
              session.context.serviceName ?? "Consulta",
              "selecting_new_slot",
              { appointmentId: session.context.appointmentId },
              attempts,
            ),
          );
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
        await showMainMenu("Conservamos tu turno sin cambios.");
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
            const message =
              `¡Listo! Tu turno quedó reprogramado.\n\n📅 ${formatDate(slot.startsAt)}\n` +
              `🕐 ${formatTime(slot.startsAt)}\n${slot.serviceName} · ${slot.professionalName}`;
            await send(textPayload(message), "Tu turno quedó reprogramado.");
            await saveSession("idle");
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
        await showMainMenu("Conservamos tu turno sin cambios.");
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
                "Tu turno fue cancelado. Si necesitás uno nuevo, podés solicitarlo desde este chat.",
              ),
              "Tu turno fue cancelado.",
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
      if (!appointment || appointment.status !== "scheduled") {
        await showMainMenu(
          "Esa pre-reserva ya no está activa. Si querés, te busco otro horario.",
        );
      } else {
        const message =
          appointment.depositStatus === "proof_received"
            ? "Ya recibí tu comprobante. Lo reviso y te confirmo el turno."
            : "Tu horario sigue pre-reservado. Mandame el comprobante como imagen o PDF y lo reviso.";
        await send(textPayload(message), message, {
          appointment_id: appointment.id,
        });
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
        await saveSession("waiting_deposit", session.context, remainingMinutes);
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
