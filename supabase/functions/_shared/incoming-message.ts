import type { SupabaseClient } from "npm:@supabase/supabase-js@2.112.2";

import { isOwnerNumber, ownerNumbersFromEnvironment } from "./owner-access.ts";

const CONSENT_POLICY_VERSION = "whatsapp-business-messaging-policy/2026-08-10";

export type IncomingMessageType =
  | "text"
  | "interactive"
  | "image"
  | "document"
  | "audio";

export interface NormalizedIncomingMessage {
  externalMessageId: string;
  phoneE164: string | null;
  whatsappId: string | null;
  whatsappUserId: string | null;
  profileName: string;
  type: IncomingMessageType;
  body: string;
  metadata: Record<string, unknown>;
  receivedAt: string;
}

export interface ProcessIncomingMessageOptions {
  client: SupabaseClient;
  message: NormalizedIncomingMessage;
  automationsEnabled: boolean;
  /** Account resolved from the signed WABA + phone identity, when managed by
   * Embedded Signup. Legacy/test messages intentionally leave it null. */
  coexistenceAccountId?: string | null;
  /**
   * Resume idempotent side effects after a webhook delivery failed after the
   * message row was inserted. Normal callers keep duplicate messages inert.
   */
  resumeSideEffectsOnDuplicate?: boolean;
  /**
   * Mark a real webhook INSERT so the database reserves its automation slot in
   * the same transaction. Direct callers intentionally leave this disabled.
   */
  reserveAutomationDispatch?: boolean;
}

export interface ProcessedIncomingMessage {
  messageId: string;
  contact: Record<string, unknown>;
  conversation: Record<string, unknown>;
  deduplicated: boolean;
  shouldRunAutomation: boolean;
}

function normalizedPhrase(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("es-AR")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

const OPT_OUT_PHRASES = new Set([
  "baja",
  "stop",
  "unsubscribe",
  "stop messages",
  "no more messages",
  "cancelar suscripcion",
  "desuscribirme",
  "dejar de recibir mensajes",
  "no quiero recibir mensajes",
  "no quiero recibir mas mensajes",
  "no deseo recibir mensajes",
  "no deseo recibir mas mensajes",
  "no recibir mas mensajes",
  "no me escriban mas",
  "no me escribas mas",
  "no me manden mas mensajes",
  "no me mandes mas mensajes",
  "deja de escribirme",
  "no quiero que me escribas mas",
  "quiero darme de baja",
  "denme de baja",
]);

const OPT_OUT_REPLY_IDS = new Set([
  "opt_out",
  "whatsapp_opt_out",
  "unsubscribe",
  "stop_messages",
]);

const OPT_IN_PHRASES = new Set(["acepto recibir recordatorios de turnos"]);

const OPT_IN_REPLY_IDS = new Set([
  "opt_in_appointment_reminders",
  "consent_appointment_updates_yes",
]);

export type WhatsAppConsentDecision = "opt_in" | "opt_out";

/**
 * Detecta únicamente frases explícitas y acotadas. También se reutiliza sobre
 * una transcripción literal para respetar una baja enviada por nota de voz;
 * una inferencia ambigua nunca concede ni revoca consentimiento.
 */
export function whatsappConsentDecisionFromText(
  value: string,
): WhatsAppConsentDecision | null {
  const phrase = normalizedPhrase(value);
  const politePhrase = phrase
    .replace(/^por favor /, "")
    .replace(/ por favor$/, "");
  const explicitOptOut =
    OPT_OUT_PHRASES.has(politePhrase) ||
    /^(baja|stop) por favor$/.test(phrase) ||
    /^(por favor )?(quiero )?(darme|denme) de baja( por favor)?$/.test(phrase);
  if (explicitOptOut) return "opt_out";
  return OPT_IN_PHRASES.has(phrase) ? "opt_in" : null;
}

function consentDecision(
  message: NormalizedIncomingMessage,
): WhatsAppConsentDecision | null {
  if (message.type !== "text" && message.type !== "interactive") return null;

  const textDecision = whatsappConsentDecisionFromText(message.body);
  const rawReplyId = message.metadata.interactive_reply_id;
  const replyId =
    typeof rawReplyId === "string"
      ? normalizedPhrase(rawReplyId).replace(/ /g, "_")
      : "";
  if (OPT_OUT_REPLY_IDS.has(replyId)) return "opt_out";
  if (OPT_IN_REPLY_IDS.has(replyId)) return "opt_in";
  return textDecision;
}

function mediaUnderstandingPossible(): boolean {
  const runtime = (
    globalThis as typeof globalThis & {
      process?: { env?: Record<string, string | undefined> };
    }
  ).process;
  const value =
    typeof Deno !== "undefined"
      ? Deno.env.get("OPENAI_ADMINISTRATIVE_ENABLED")
      : runtime?.env?.OPENAI_ADMINISTRATIVE_ENABLED;
  return value?.trim() === "true";
}

export function shouldDispatchIncomingAutomation(input: {
  automationsEnabled: boolean;
  optedOut: boolean;
  humanReview: boolean;
  priority: boolean;
  owner: boolean;
  readableMedia: boolean;
  humanReviewPauseOwned: boolean;
  automationMode: unknown;
}): boolean {
  return (
    input.automationsEnabled &&
    !input.optedOut &&
    (!input.humanReview ||
      input.priority ||
      input.owner ||
      input.readableMedia ||
      input.humanReviewPauseOwned) &&
    (input.automationMode === "auto" ||
      input.humanReviewPauseOwned ||
      input.owner)
  );
}

export function requiresHumanReview(
  message: NormalizedIncomingMessage,
): boolean {
  // Un adjunto que la automatización todavía no sabe leer nunca sigue sola: una
  // nota de voz sin transcribir es tan opaca para el bot como un comprobante.
  if (
    message.type === "image" ||
    message.type === "document" ||
    message.type === "audio"
  ) {
    return true;
  }
  const phrase = normalizedPhrase(message.body);
  return /\b(diagnostico|receta|medicacion|dosis|historia clinica|resultado de estudio|urgencias?|emergencias?|dolor intenso|dolor fuerte|sangrado|accidente|traumatismo)\b/.test(
    phrase,
  );
}

/** Gisela agenda y cotiza las urgencias personalmente, así que un mensaje que
 * las nombra nunca sigue el flujo automático de reserva. */
export function requiresPriority(message: NormalizedIncomingMessage): boolean {
  if (message.type !== "text" && message.type !== "interactive") return false;
  const phrase = normalizedPhrase(message.body);
  return /\b(urgencias?|emergencias?|dolor intenso|dolor fuerte|sangrado|accidente|traumatismo)\b/.test(
    phrase,
  );
}

async function recordConsent(
  client: SupabaseClient,
  contactId: string,
  messageId: string,
  externalMessageId: string,
  decision: "opt_in" | "opt_out",
): Promise<void> {
  const { error } = await client.rpc("record_whatsapp_consent", {
    p_contact_id: contactId,
    p_decision: decision,
    p_purpose: decision === "opt_in" ? "appointment_updates" : "all",
    p_source: "whatsapp",
    p_evidence_ref: `whatsapp_message:${externalMessageId}`,
    p_policy_version: CONSENT_POLICY_VERSION,
    p_whatsapp_message_id: externalMessageId,
  });
  if (error) throw new Error(`CONSENT_RECORD_FAILED:${error.message}`);

  // Keep the database message ID available in the audit trail without making
  // it part of the consent evidence identifier expected by existing reports.
  void messageId;
}

export async function getOrCreateWhatsAppContact(
  client: SupabaseClient,
  phone: string | null,
  whatsappId: string | null,
  profileName: string,
  whatsappUserId: string | null = null,
): Promise<Record<string, unknown>> {
  if (!phone && !whatsappUserId) {
    throw new Error("WHATSAPP_CONTACT_IDENTITY_REQUIRED");
  }
  const selection =
    "id,phone_e164,whatsapp_id,whatsapp_user_id,name,coverage,is_existing_patient,alternate_phone_e164";
  const findBy = async (
    column: "phone_e164" | "whatsapp_id" | "whatsapp_user_id",
    value: string | null,
  ): Promise<Record<string, unknown> | null> => {
    if (!value) return null;
    const result = await client
      .from("contacts")
      .select(selection)
      .eq(column, value)
      .maybeSingle();
    if (result.error) throw result.error;
    return (result.data as Record<string, unknown> | null) ?? null;
  };

  const [byUserId, byPhone, byWhatsAppId] = await Promise.all([
    findBy("whatsapp_user_id", whatsappUserId),
    findBy("phone_e164", phone),
    findBy("whatsapp_id", whatsappId),
  ]);
  const matchedContactIds = new Set(
    [byUserId, byPhone, byWhatsAppId]
      .map((contact) => contact?.id)
      .filter(Boolean),
  );
  if (matchedContactIds.size > 1) {
    throw new Error("WHATSAPP_IDENTITY_CONFLICT");
  }

  const existing = byUserId ?? byPhone ?? byWhatsAppId;
  if (existing) {
    if (
      (phone && existing.phone_e164 && existing.phone_e164 !== phone) ||
      (whatsappId &&
        existing.whatsapp_id &&
        existing.whatsapp_id !== whatsappId) ||
      (whatsappUserId &&
        existing.whatsapp_user_id &&
        existing.whatsapp_user_id !== whatsappUserId)
    ) {
      throw new Error("WHATSAPP_IDENTITY_CONFLICT");
    }
    const updates: Record<string, unknown> = {};
    if (phone && !existing.phone_e164) updates.phone_e164 = phone;
    if (whatsappId && !existing.whatsapp_id) updates.whatsapp_id = whatsappId;
    if (whatsappUserId && !existing.whatsapp_user_id) {
      updates.whatsapp_user_id = whatsappUserId;
    }
    if (
      (existing.name === "Paciente" || existing.name === "Contacto") &&
      profileName !== "Paciente"
    ) {
      updates.name = profileName;
    }
    if (!Object.keys(updates).length) return existing;

    const { data, error } = await client
      .from("contacts")
      .update(updates)
      .eq("id", existing.id)
      .select(selection)
      .single();
    if (error || !data) throw error ?? new Error("CONTACT_UPDATE_FAILED");
    return data as Record<string, unknown>;
  }

  const inserted = await client
    .from("contacts")
    .insert({
      phone_e164: phone,
      whatsapp_id: whatsappId,
      whatsapp_user_id: whatsappUserId,
      name: profileName,
    })
    .select(selection)
    .single();
  if (!inserted.error && inserted.data) {
    return inserted.data as Record<string, unknown>;
  }
  if (inserted.error?.code !== "23505") {
    throw inserted.error ?? new Error("CONTACT_CREATE_FAILED");
  }

  const [racedByUserId, racedByPhone, racedByWhatsAppId] = await Promise.all([
    findBy("whatsapp_user_id", whatsappUserId),
    findBy("phone_e164", phone),
    findBy("whatsapp_id", whatsappId),
  ]);
  const racedIds = new Set(
    [racedByUserId, racedByPhone, racedByWhatsAppId]
      .map((contact) => contact?.id)
      .filter(Boolean),
  );
  if (racedIds.size > 1) {
    throw new Error("WHATSAPP_IDENTITY_CONFLICT");
  }
  const raced = racedByUserId ?? racedByPhone ?? racedByWhatsAppId;
  if (!raced) throw new Error("CONTACT_LOOKUP_FAILED");
  return raced;
}

export async function getOrCreateWhatsAppConversation(
  client: SupabaseClient,
  contactId: string,
): Promise<Record<string, unknown>> {
  const { data, error } = await client.rpc("get_or_create_open_conversation", {
    p_contact_id: contactId,
  });
  if (error || !data) throw error ?? new Error("CONVERSATION_FAILED");
  return (Array.isArray(data) ? data[0] : data) as Record<string, unknown>;
}

export async function processIncomingMessage(
  options: ProcessIncomingMessageOptions,
): Promise<ProcessedIncomingMessage> {
  const {
    client,
    message,
    automationsEnabled,
    coexistenceAccountId = null,
    resumeSideEffectsOnDuplicate = false,
    reserveAutomationDispatch = false,
  } = options;
  if (
    coexistenceAccountId !== null &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      coexistenceAccountId,
    )
  ) {
    throw new Error("INVALID_COEXISTENCE_ACCOUNT_ID");
  }
  const contact = await getOrCreateWhatsAppContact(
    client,
    message.phoneE164,
    message.whatsappId,
    message.profileName,
    message.whatsappUserId,
  );
  const conversation = await getOrCreateWhatsAppConversation(
    client,
    contact.id as string,
  );

  const inserted = await client
    .from("messages")
    .insert({
      conversation_id: conversation.id,
      contact_id: contact.id,
      direction: "inbound",
      whatsapp_message_id: message.externalMessageId,
      type: message.type,
      body: message.body,
      status: "delivered",
      coexistence_account_id: coexistenceAccountId,
      metadata: {
        ...message.metadata,
        ...(reserveAutomationDispatch
          ? { automation_dispatch_reserved: true }
          : {}),
      },
      created_at: message.receivedAt,
    })
    .select("id")
    .single();

  let savedMessage = inserted.data;
  let deduplicated = false;
  if (inserted.error?.code === "23505") {
    const existing = await client
      .from("messages")
      .select(
        "id,whatsapp_origin,conversation_id,contact_id,coexistence_account_id",
      )
      .eq("whatsapp_message_id", message.externalMessageId)
      .single();
    if (existing.error || !existing.data) {
      throw existing.error ?? new Error("MESSAGE_FAILED");
    }
    savedMessage = existing.data;
    deduplicated = true;

    const existingAccountId = existing.data.coexistence_account_id ?? null;
    if (
      (coexistenceAccountId !== null &&
        existingAccountId !== coexistenceAccountId) ||
      (coexistenceAccountId === null && existingAccountId !== null)
    ) {
      throw new Error("WHATSAPP_MESSAGE_ACCOUNT_CONFLICT");
    }

    if (
      existing.data.whatsapp_origin === "history" &&
      resumeSideEffectsOnDuplicate &&
      reserveAutomationDispatch
    ) {
      const promoted = await client.rpc(
        "promote_whatsapp_history_message_to_live",
        {
          p_whatsapp_message_id: message.externalMessageId,
          p_contact_id: contact.id,
          p_conversation_id: conversation.id,
          p_message_type: message.type,
          p_body: message.body,
          p_message_at: message.receivedAt,
          p_metadata: {
            ...message.metadata,
            automation_dispatch_reserved: true,
          },
        },
      );
      const promotedRow = (
        Array.isArray(promoted.data) ? promoted.data[0] : promoted.data
      ) as { message_id?: string; promoted?: boolean } | null;
      if (promoted.error || !promotedRow?.message_id) {
        throw new Error(
          `HISTORY_MESSAGE_PROMOTION_FAILED:${promoted.error?.message ?? "NO_ROW"}`,
        );
      }
      savedMessage = { id: promotedRow.message_id };
    }
  } else if (inserted.error || !savedMessage) {
    throw inserted.error ?? new Error("MESSAGE_FAILED");
  }

  if (deduplicated && !resumeSideEffectsOnDuplicate) {
    return {
      messageId: savedMessage.id as string,
      contact,
      conversation,
      deduplicated: true,
      shouldRunAutomation: false,
    };
  }

  const decision = consentDecision(message);
  if (decision) {
    await recordConsent(
      client,
      contact.id as string,
      savedMessage.id as string,
      message.externalMessageId,
      decision,
    );
  }

  const humanReview = requiresHumanReview(message);
  const priority = requiresPriority(message);
  // Un mensaje del número personal autorizado no se deriva "a una persona":
  // del otro lado ya está la profesional. Pausar su propia conversación la
  // dejaría sin respuesta, que es exactamente lo que hay que evitar.
  const owner = isOwnerNumber(message.phoneE164, ownerNumbersFromEnvironment());
  // Un adjunto deja de ser opaco cuando la lectura por IA está habilitada: la
  // automatización lo transcribe o lo lee y recién ahí decide si sigue sola o
  // deriva. Si la lectura está apagada, la pausa queda asociada a este inbound
  // y el worker igual se despierta para acusar recibo y dejarlo en revisión.
  const readableMedia =
    automationsEnabled &&
    mediaUnderstandingPossible() &&
    (message.type === "audio" ||
      message.type === "image" ||
      message.type === "document");
  let humanReviewPauseOwned = false;
  if (humanReview && !readableMedia && !owner && decision !== "opt_out") {
    // Establish ownership before any deposit-proof RPC can also move the
    // conversation to manual. An app echo or operator pause is never replaced.
    const pause = await client.rpc(
      "pause_whatsapp_automation_for_inbound_handoff",
      {
        p_message_id: savedMessage.id,
        p_priority: priority,
        p_current_flow: null,
      },
    );
    if (pause.error) throw pause.error;
    humanReviewPauseOwned = pause.data === true;
  }

  // La asociación y el eventual cambio de estado del turno ocurren recién
  // después de leer el archivo en whatsapp-automation. Así una radiografía o
  // cualquier otro documento nunca se registra como seña sólo por ser adjunto.

  return {
    messageId: savedMessage.id as string,
    contact,
    conversation,
    deduplicated,
    shouldRunAutomation: shouldDispatchIncomingAutomation({
      automationsEnabled,
      optedOut: decision === "opt_out",
      humanReview,
      priority,
      owner,
      readableMedia,
      humanReviewPauseOwned,
      automationMode: conversation.automation_mode,
    }),
  };
}
