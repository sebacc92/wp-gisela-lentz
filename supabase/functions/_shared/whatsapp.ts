import type { SupabaseClient } from "npm:@supabase/supabase-js@2.112.2";

export interface WhatsAppContact {
  id: string;
  phone_e164: string | null;
  whatsapp_id: string | null;
  whatsapp_user_id: string | null;
  name: string;
  whatsapp_opt_in_at?: string | null;
  whatsapp_opt_out_at?: string | null;
  whatsapp_consent_status?: "unknown" | "opted_in" | "opted_out";
  coverage?: "ioma" | "particular" | null;
  is_existing_patient?: boolean | null;
  alternate_phone_e164?: string | null;
}

export interface WhatsAppConversation {
  id: string;
  contact_id: string;
  last_inbound_message_at: string | null;
  automation_mode: "auto" | "manual";
  needs_human: boolean;
  automation_pause_source?:
    | "app_echo"
    | "inbound_handoff"
    | "operator"
    | "system"
    | "legacy_manual"
    | null;
  automation_pause_message_id?: string | null;
}

interface GraphResponse {
  messages?: Array<{ id: string }>;
  error?: {
    message?: string;
    code?: number;
    error_subcode?: number;
    is_transient?: boolean;
    error_data?: { details?: string };
  };
}

export interface RecordedMessage {
  id: string;
  whatsapp_message_id: string | null;
  status: "pending" | "sent" | "delivered" | "read" | "failed";
  deduplicated: boolean;
}

export type ExistingWhatsAppDispatchDisposition =
  | "completed"
  | "in_progress"
  | "retryable_failure"
  | "terminal_failure";

/**
 * A reserved outbound row is not proof that Meta accepted the message.
 * Keeping this decision pure makes every idempotency race take the same
 * fail-closed path instead of accidentally treating `pending` as success.
 */
export function existingWhatsAppDispatchDisposition(row: {
  status?: unknown;
  metadata?: unknown;
}): ExistingWhatsAppDispatchDisposition {
  if (
    row.status === "sent" ||
    row.status === "delivered" ||
    row.status === "read"
  ) {
    return "completed";
  }
  if (row.status === "pending") return "in_progress";
  if (row.status === "failed") {
    const metadata =
      row.metadata && typeof row.metadata === "object"
        ? (row.metadata as Record<string, unknown>)
        : {};
    const attempts = Number(metadata.send_attempts ?? 1);
    return metadata.error_retryable === true &&
      Number.isFinite(attempts) &&
      attempts < 3
      ? "retryable_failure"
      : "terminal_failure";
  }
  return "terminal_failure";
}

export class WhatsAppPolicyError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`WHATSAPP_POLICY:${code}`);
    this.name = "WhatsAppPolicyError";
    this.code = code;
  }
}

export class WhatsAppDispatchError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly graphCode: number | null;
  readonly graphSubcode: number | null;

  constructor(
    code: string,
    options: {
      message?: string;
      retryable?: boolean;
      graphCode?: number | null;
      graphSubcode?: number | null;
    } = {},
  ) {
    super(options.message ? `${code}:${options.message}` : code);
    this.name = "WhatsAppDispatchError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.graphCode = options.graphCode ?? null;
    this.graphSubcode = options.graphSubcode ?? null;
  }
}

export function isWhatsAppPolicyError(
  error: unknown,
): error is WhatsAppPolicyError {
  return error instanceof WhatsAppPolicyError;
}

/**
 * PostgREST returns database exceptions as plain objects, so an instanceof
 * check alone cannot recognize the transactional manual-mode barrier.
 */
export function whatsAppPolicyCode(error: unknown): string | null {
  if (error instanceof WhatsAppPolicyError) return error.code;
  const message =
    error instanceof Error
      ? error.message
      : error && typeof error === "object" && "message" in error
        ? String((error as { message?: unknown }).message ?? "")
        : "";
  return message
    .toUpperCase()
    .includes("WHATSAPP_AUTOMATION_EFFECT_BLOCKED_MANUAL")
    ? "AUTOMATION_PAUSED"
    : null;
}

export function shouldRetryWhatsAppError(error: unknown): boolean {
  if (error instanceof WhatsAppPolicyError) return false;
  if (error instanceof WhatsAppDispatchError) return error.retryable;
  if (!(error instanceof Error)) return false;
  return (
    error.message.startsWith("CONFIGURATION_INCOMPLETE") ||
    error.message.startsWith("MESSAGE_INSERT_FAILED")
  );
}

/**
 * Environment safety flags only accept explicit `true` or `false` values.
 * Missing, empty or misspelled values fall back to the safer behavior chosen
 * by each caller.
 */
export function parseSafetyBoolean(
  value: string | null | undefined,
  safeDefault: boolean,
): boolean {
  const normalized = value?.trim().toLocaleLowerCase("en-US");
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return safeDefault;
}

export function normalizeWhatsAppNumber(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || !/^\+?[0-9\s().-]+$/.test(trimmed)) return null;

  const digits = trimmed.replace(/\D/g, "");
  return /^[1-9][0-9]{7,14}$/.test(digits) ? digits : null;
}

export function whatsappRecipient(contact: WhatsAppContact): string {
  const recipient =
    contact.whatsapp_user_id?.trim() ||
    contact.whatsapp_id?.trim() ||
    contact.phone_e164?.replace(/^\+/, "").trim() ||
    "";
  if (!recipient) throw new WhatsAppPolicyError("CONTACT_IDENTITY_MISSING");
  return recipient;
}

export function parseWhatsAppAllowedNumbers(
  value: string | null | undefined,
): Set<string> {
  const numbers = new Set<string>();
  for (const candidate of value?.split(/[,;\n]+/) ?? []) {
    const normalized = normalizeWhatsAppNumber(candidate);
    if (normalized) numbers.add(normalized);
  }
  return numbers;
}

export function isWhatsAppTestRecipientAllowed(
  recipient: string,
  testModeValue: string | null | undefined,
  allowedNumbersValue: string | null | undefined,
): boolean {
  const testMode = parseSafetyBoolean(testModeValue, true);
  if (!testMode) return true;

  const normalizedRecipient = normalizeWhatsAppNumber(recipient);
  return Boolean(
    normalizedRecipient &&
    parseWhatsAppAllowedNumbers(allowedNumbersValue).has(normalizedRecipient),
  );
}

export function whatsappAutomationsEnabled(): boolean {
  return parseSafetyBoolean(
    Deno.env.get("WHATSAPP_AUTOMATIONS_ENABLED"),
    false,
  );
}

export function isAutomaticWhatsAppSource(value: string | null): boolean {
  return (
    value === "automation" ||
    value === "handoff" ||
    value === "urgent_handoff" ||
    value === "reminder" ||
    value === "deposit_request" ||
    value === "proof_acknowledgement" ||
    value === "hold_expiration"
  );
}

export function isCausallyOwnedManualAutomationNotice(args: {
  source: string | null;
  pauseSource: string | null;
  pauseMessageId: string | null;
  inboundMessageId: string | null;
}): boolean {
  return (
    (args.source === "handoff" ||
      args.source === "urgent_handoff" ||
      args.source === "proof_acknowledgement") &&
    args.pauseSource === "inbound_handoff" &&
    Boolean(args.inboundMessageId) &&
    args.pauseMessageId === args.inboundMessageId
  );
}

export type OperatorWhatsAppPurpose =
  | "operator_message"
  | "operator_deposit_request"
  | "operator_deposit_confirmation";

export function isOperatorWhatsAppPurpose(
  value: unknown,
): value is OperatorWhatsAppPurpose {
  return (
    value === "operator_message" ||
    value === "operator_deposit_request" ||
    value === "operator_deposit_confirmation"
  );
}

export function operatorSourceForPurpose(
  purpose: OperatorWhatsAppPurpose,
): "operator" | "operator_deposit_request" | "operator_deposit_confirmation" {
  return purpose === "operator_message" ? "operator" : purpose;
}

function isOperatorWhatsAppSource(value: string | null): boolean {
  return (
    value === "operator" ||
    value === "operator_deposit_request" ||
    value === "operator_deposit_confirmation"
  );
}

function whatsappTestModeEnabled(): boolean {
  return parseSafetyBoolean(Deno.env.get("WHATSAPP_TEST_MODE"), true);
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`CONFIGURATION_INCOMPLETE:${name}`);
  return value;
}

export function graphConfiguration(): {
  accessToken: string;
  phoneNumberId: string;
  businessAccountId: string;
  apiVersion: string;
} {
  const phoneNumberId = requiredEnv("WHATSAPP_PHONE_NUMBER_ID");
  const businessAccountId = requiredEnv("WHATSAPP_BUSINESS_ACCOUNT_ID");
  const apiVersion = requiredEnv("WHATSAPP_GRAPH_API_VERSION");
  if (!/^\d+$/.test(phoneNumberId)) {
    throw new Error("CONFIGURATION_INCOMPLETE:WHATSAPP_PHONE_NUMBER_ID");
  }
  if (!/^\d+$/.test(businessAccountId)) {
    throw new Error("CONFIGURATION_INCOMPLETE:WHATSAPP_BUSINESS_ACCOUNT_ID");
  }
  if (!/^v\d+\.\d+$/.test(apiVersion)) {
    throw new Error("CONFIGURATION_INCOMPLETE:WHATSAPP_GRAPH_API_VERSION");
  }
  return {
    accessToken: requiredEnv("WHATSAPP_ACCESS_TOKEN"),
    phoneNumberId,
    businessAccountId,
    apiVersion,
  };
}

export function validIdempotencyKey(value: string): boolean {
  return (
    value.length >= 8 &&
    value.length <= 200 &&
    /^[A-Za-z0-9][A-Za-z0-9:._-]*$/.test(value)
  );
}

export function hasActiveWhatsAppConsent(contact: {
  whatsapp_opt_in_at?: string | null;
  whatsapp_opt_out_at?: string | null;
  whatsapp_consent_status?: "unknown" | "opted_in" | "opted_out";
}): boolean {
  if (
    contact.whatsapp_consent_status !== undefined &&
    contact.whatsapp_consent_status !== "opted_in"
  ) {
    return false;
  }
  if (!contact.whatsapp_opt_in_at) return false;
  const optedInAt = new Date(contact.whatsapp_opt_in_at).getTime();
  if (!Number.isFinite(optedInAt)) return false;
  if (!contact.whatsapp_opt_out_at) return true;
  const optedOutAt = new Date(contact.whatsapp_opt_out_at).getTime();
  return Number.isFinite(optedOutAt) && optedInAt > optedOutAt;
}

export function isCustomerServiceWindowOpen(
  lastInboundMessageAt: string | null,
): boolean {
  if (!lastInboundMessageAt) return false;
  const openedAt = new Date(lastInboundMessageAt).getTime();
  return (
    Number.isFinite(openedAt) && Date.now() - openedAt < 24 * 60 * 60 * 1000
  );
}

export function textPayload(body: string): Record<string, unknown> {
  return { type: "text", text: { preview_url: false, body } };
}

export function buttonsPayload(
  body: string,
  buttons: Array<{ id: string; title: string }>,
): Record<string, unknown> {
  return {
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: body },
      action: {
        buttons: buttons.slice(0, 3).map((button) => ({
          type: "reply",
          reply: button,
        })),
      },
    },
  };
}

export function listPayload(
  body: string,
  buttonText: string,
  rows: Array<{ id: string; title: string; description?: string }>,
): Record<string, unknown> {
  return {
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: body },
      action: {
        button: buttonText,
        sections: [{ title: "Opciones", rows: rows.slice(0, 10) }],
      },
    },
  };
}

interface InteractiveOption {
  id: string;
  title: string;
  description?: string;
}

function interactiveOptionsFromPayload(
  payload: Record<string, unknown>,
): InteractiveOption[] {
  if (payload.type !== "interactive" || !payload.interactive) return [];
  const interactive = payload.interactive as Record<string, unknown>;
  const action = interactive.action as Record<string, unknown> | undefined;
  if (!action) return [];

  const buttons = Array.isArray(action.buttons) ? action.buttons : [];
  const buttonOptions = buttons.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const reply = (candidate as Record<string, unknown>).reply;
    if (!reply || typeof reply !== "object") return [];
    const row = reply as Record<string, unknown>;
    return typeof row.id === "string" && typeof row.title === "string"
      ? [{ id: row.id, title: row.title }]
      : [];
  });
  if (buttonOptions.length) return buttonOptions.slice(0, 10);

  const sections = Array.isArray(action.sections) ? action.sections : [];
  return sections
    .flatMap((section) => {
      if (!section || typeof section !== "object") return [];
      const rows = (section as Record<string, unknown>).rows;
      if (!Array.isArray(rows)) return [];
      return rows.flatMap((candidate) => {
        if (!candidate || typeof candidate !== "object") return [];
        const row = candidate as Record<string, unknown>;
        if (typeof row.id !== "string" || typeof row.title !== "string") {
          return [];
        }
        return [
          {
            id: row.id,
            title: row.title,
            ...(typeof row.description === "string"
              ? { description: row.description }
              : {}),
          },
        ];
      });
    })
    .slice(0, 10);
}

export function templatePayload(
  name: string,
  languageCode: string,
  parameters: string[] = [],
): Record<string, unknown> {
  return {
    type: "template",
    template: {
      name,
      language: { code: languageCode },
      components: parameters.length
        ? [
            {
              type: "body",
              parameters: parameters.map((text) => ({ type: "text", text })),
            },
          ]
        : undefined,
    },
  };
}

function messageTypeFromPayload(
  payload: Record<string, unknown>,
): "text" | "template" | "interactive" {
  if (payload.type === "template") return "template";
  if (payload.type === "interactive") return "interactive";
  if (payload.type === "text") return "text";
  throw new WhatsAppPolicyError("UNSUPPORTED_OUTBOUND_MESSAGE_TYPE");
}

function normalizedPolicyText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("es-AR");
}

function assertAdministrativePayload(
  bodyPreview: string,
  payload: Record<string, unknown>,
): void {
  const value = normalizedPolicyText(
    `${bodyPreview}\n${JSON.stringify(payload)}`,
  );
  const asksForSensitiveIdentifier =
    /\b(envi|manda|mandame|comparti|compartime|indica|pasame|necesitamos|necesito)\w*\b/.test(
      value,
    ) &&
    /\b(dni|documento de identidad|pasaporte|cuil|cuit|tarjeta|cuenta bancaria|cbu|numero de cuenta)\b/.test(
      value,
    );
  const containsClinicalContent =
    /\b(historia clinica|motivo (de|del) consulta|diagnostico|receta|medicacion|dosis|sintomas?|resultado(s)? (de|del) (un )?estudio|foto (de|del) (lesion|zona afectada))\b/.test(
      value,
    );

  if (asksForSensitiveIdentifier || containsClinicalContent) {
    throw new WhatsAppPolicyError("SENSITIVE_OR_CLINICAL_CONTENT");
  }
}

interface OutboundPolicyContext {
  templateKey: string | null;
  appointmentId: string | null;
}

async function assertOutboundPolicy(args: {
  client: SupabaseClient;
  conversation: WhatsAppConversation;
  contact: WhatsAppContact;
  type: "text" | "template" | "interactive";
  templateName: string | null;
  templateKey: string | null;
  appointmentId: string | null;
  source: string | null;
  automationOwnerMessageId: string | null;
}): Promise<OutboundPolicyContext> {
  const {
    client,
    conversation,
    contact,
    type,
    templateName,
    templateKey,
    appointmentId,
    source,
    automationOwnerMessageId,
  } = args;
  const [conversationResult, contactResult, settingsResult] = await Promise.all(
    [
      client
        .from("conversations")
        .select(
          "id,contact_id,last_inbound_message_at,automation_mode,automation_pause_source,automation_pause_message_id",
        )
        .eq("id", conversation.id)
        .single(),
      client
        .from("contacts")
        .select(
          "id,whatsapp_opt_in_at,whatsapp_opt_out_at,whatsapp_consent_status",
        )
        .eq("id", contact.id)
        .single(),
      client
        .from("whatsapp_settings")
        .select("sending_paused,quality_rating")
        .eq("id", true)
        .single(),
    ],
  );

  if (
    settingsResult.error ||
    !settingsResult.data ||
    settingsResult.data.sending_paused
  ) {
    throw new WhatsAppPolicyError("SENDING_PAUSED");
  }

  if (
    conversationResult.error ||
    !conversationResult.data ||
    conversationResult.data.contact_id !== contact.id
  ) {
    throw new WhatsAppPolicyError("CONVERSATION_CONTEXT_INVALID");
  }
  if (contactResult.error || !contactResult.data) {
    throw new WhatsAppPolicyError("CONTACT_CONTEXT_INVALID");
  }

  const freshConversation = conversationResult.data as {
    id: string;
    contact_id: string;
    last_inbound_message_at: string | null;
    automation_mode: "auto" | "manual";
    automation_pause_source: string | null;
    automation_pause_message_id: string | null;
  };
  const freshContact = contactResult.data as {
    id: string;
    whatsapp_opt_in_at: string | null;
    whatsapp_opt_out_at: string | null;
    whatsapp_consent_status: "unknown" | "opted_in" | "opted_out";
  };

  const automaticSource = isAutomaticWhatsAppSource(source);
  if (automaticSource && !whatsappAutomationsEnabled()) {
    throw new WhatsAppPolicyError("AUTOMATIONS_DISABLED");
  }
  if (automaticSource) {
    const ownedManualNotice = isCausallyOwnedManualAutomationNotice({
      source,
      pauseSource: freshConversation.automation_pause_source,
      pauseMessageId: freshConversation.automation_pause_message_id,
      inboundMessageId: automationOwnerMessageId,
    });
    if (freshConversation.automation_mode !== "auto" && !ownedManualNotice) {
      throw new WhatsAppPolicyError("AUTOMATION_PAUSED");
    }
  }

  if (type !== "template") {
    if (
      !isCustomerServiceWindowOpen(freshConversation.last_inbound_message_at)
    ) {
      throw new WhatsAppPolicyError("CUSTOMER_SERVICE_WINDOW_CLOSED");
    }

    if (freshContact.whatsapp_opt_out_at) {
      const optedOutAt = new Date(freshContact.whatsapp_opt_out_at).getTime();
      const lastInboundAt = new Date(
        freshConversation.last_inbound_message_at ?? "",
      ).getTime();
      if (
        Number.isFinite(optedOutAt) &&
        (!Number.isFinite(lastInboundAt) || lastInboundAt <= optedOutAt)
      ) {
        throw new WhatsAppPolicyError("CONTACT_OPTED_OUT");
      }
    }

    if (
      source === "deposit_request" ||
      source === "proof_acknowledgement" ||
      source === "hold_expiration" ||
      source === "operator_deposit_request" ||
      source === "operator_deposit_confirmation"
    ) {
      if (!appointmentId) {
        throw new WhatsAppPolicyError("APPOINTMENT_CONTEXT_REQUIRED");
      }
      const { data: appointment, error: appointmentError } = await client
        .from("appointments")
        .select(
          "id,contact_id,status,deposit_status,deposit_proof_late,hold_expires_at,hold_expired_notification_status",
        )
        .eq("id", appointmentId)
        .eq("contact_id", contact.id)
        .maybeSingle();
      if (appointmentError || !appointment) {
        throw new WhatsAppPolicyError("APPOINTMENT_CONTEXT_INVALID");
      }
      if (
        (source === "deposit_request" ||
          source === "operator_deposit_request") &&
        (appointment.status !== "scheduled" ||
          appointment.deposit_status !== "pending" ||
          !appointment.hold_expires_at ||
          new Date(appointment.hold_expires_at).getTime() <= Date.now())
      ) {
        throw new WhatsAppPolicyError("DEPOSIT_REQUEST_STALE");
      }
      if (
        source === "operator_deposit_confirmation" &&
        (appointment.status !== "confirmed" ||
          (appointment.deposit_status !== "confirmed" &&
            appointment.deposit_status !== "not_required"))
      ) {
        throw new WhatsAppPolicyError("DEPOSIT_CONFIRMATION_STALE");
      }
      if (
        source === "proof_acknowledgement" &&
        (appointment.status !== "scheduled" ||
          appointment.deposit_status !== "proof_received" ||
          appointment.deposit_proof_late === true)
      ) {
        throw new WhatsAppPolicyError("DEPOSIT_PROOF_ACKNOWLEDGEMENT_STALE");
      }
      if (
        source === "hold_expiration" &&
        (appointment.status !== "cancelled" ||
          appointment.deposit_status !== "expired" ||
          appointment.deposit_proof_late === true ||
          appointment.hold_expired_notification_status !== "processing")
      ) {
        throw new WhatsAppPolicyError("HOLD_EXPIRATION_STALE");
      }
    }
    return { templateKey: null, appointmentId: null };
  }

  if (!hasActiveWhatsAppConsent(freshContact)) {
    throw new WhatsAppPolicyError("UTILITY_CONSENT_REQUIRED");
  }
  if (settingsResult.data.quality_rating !== "GREEN") {
    throw new WhatsAppPolicyError("NUMBER_QUALITY_UNVERIFIED");
  }
  if (!templateKey || !templateName) {
    throw new WhatsAppPolicyError("TEMPLATE_CONTEXT_REQUIRED");
  }
  if (!appointmentId) {
    throw new WhatsAppPolicyError("APPOINTMENT_CONTEXT_REQUIRED");
  }

  const [templateResult, appointmentResult] = await Promise.all([
    client
      .from("message_templates")
      .select("key,meta_name,category,meta_status,quality_rating,enabled")
      .eq("key", templateKey)
      .maybeSingle(),
    client
      .from("appointments")
      .select("id,contact_id,starts_at,status")
      .eq("id", appointmentId)
      .eq("contact_id", contact.id)
      .maybeSingle(),
  ]);

  if (templateResult.error || !templateResult.data) {
    throw new WhatsAppPolicyError("TEMPLATE_POLICY_UNAVAILABLE");
  }
  const template = templateResult.data as {
    key: string;
    meta_name: string;
    category: string | null;
    meta_status: string | null;
    quality_rating: string | null;
    enabled: boolean;
  };
  if (!template.enabled || template.meta_name !== templateName) {
    throw new WhatsAppPolicyError("TEMPLATE_UNAVAILABLE");
  }
  if ((template.meta_status ?? "").toUpperCase() !== "APPROVED") {
    throw new WhatsAppPolicyError("TEMPLATE_NOT_APPROVED");
  }
  if ((template.category ?? "").toUpperCase() !== "UTILITY") {
    throw new WhatsAppPolicyError("TEMPLATE_NOT_UTILITY");
  }
  if ((template.quality_rating ?? "").toUpperCase() === "RED") {
    throw new WhatsAppPolicyError("TEMPLATE_QUALITY_RED");
  }

  if (appointmentResult.error || !appointmentResult.data) {
    throw new WhatsAppPolicyError("APPOINTMENT_CONTEXT_INVALID");
  }
  if (templateKey.startsWith("appointment_reminder_")) {
    const appointment = appointmentResult.data as {
      starts_at: string;
      status: string;
    };
    if (
      appointment.status !== "confirmed" ||
      new Date(appointment.starts_at).getTime() <= Date.now()
    ) {
      throw new WhatsAppPolicyError("REMINDER_APPOINTMENT_INACTIVE");
    }
  }

  return { templateKey, appointmentId };
}

const RETRYABLE_GRAPH_CODES = new Set([4, 80007, 130429, 131056]);
const NON_RETRYABLE_POLICY_GRAPH_CODES = new Set([
  10, 200, 368, 131026, 131031, 131047, 131048, 131049, 132000, 132001, 132005,
  132007, 132012, 132015, 132016,
]);

function graphDispatchError(
  responseStatus: number,
  result: GraphResponse,
): WhatsAppDispatchError {
  const graphCode = result.error?.code ?? null;
  const graphSubcode = result.error?.error_subcode ?? null;
  const isPolicyError =
    graphCode !== null && NON_RETRYABLE_POLICY_GRAPH_CODES.has(graphCode);
  const retryable =
    !isPolicyError &&
    (result.error?.is_transient === true ||
      responseStatus === 429 ||
      (graphCode !== null && RETRYABLE_GRAPH_CODES.has(graphCode)));
  const detail =
    result.error?.error_data?.details ??
    result.error?.message ??
    `HTTP_${responseStatus}`;
  return new WhatsAppDispatchError(
    isPolicyError ? "META_POLICY_REJECTED" : "META_SEND_FAILED",
    {
      message: detail.slice(0, 300),
      retryable,
      graphCode,
      graphSubcode,
    },
  );
}

async function dispatchWhatsAppPayload(args: {
  recipient: string;
  payload: Record<string, unknown>;
  opaqueMessageId: string;
}): Promise<{ whatsappMessageId: string; requestId: string | null }> {
  const config = graphConfiguration();
  const response = await fetch(
    `https://graph.facebook.com/${config.apiVersion}/${config.phoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: args.recipient,
        biz_opaque_callback_data: args.opaqueMessageId,
        ...args.payload,
      }),
    },
  );
  const responseBody = await response.text();
  let result: GraphResponse = {};
  try {
    result = JSON.parse(responseBody) as GraphResponse;
  } catch {
    result = {};
  }
  const whatsappMessageId = result.messages?.[0]?.id;
  if (!response.ok || !whatsappMessageId) {
    throw graphDispatchError(response.status, result);
  }
  return {
    whatsappMessageId,
    requestId: response.headers.get("x-fb-request-id"),
  };
}

function policyErrorFromDatabase(message: string): WhatsAppPolicyError | null {
  const normalized = message.toUpperCase();
  const databaseCode = normalized.match(/\bPOLICY_[A-Z_]+\b/)?.[0];
  if (!databaseCode) return null;
  const publicCodes: Record<string, string> = {
    POLICY_SENDING_PAUSED: "SENDING_PAUSED",
    POLICY_NUMBER_QUALITY_UNVERIFIED: "NUMBER_QUALITY_UNVERIFIED",
    POLICY_CONSENT_REQUIRED: "UTILITY_CONSENT_REQUIRED",
    POLICY_TEMPLATE_NOT_APPROVED: "TEMPLATE_NOT_APPROVED",
    POLICY_APPOINTMENT_CONTEXT_REQUIRED: "APPOINTMENT_CONTEXT_REQUIRED",
    POLICY_CUSTOMER_SERVICE_WINDOW_CLOSED: "CUSTOMER_SERVICE_WINDOW_CLOSED",
    POLICY_CONTACT_OPTED_OUT: "CONTACT_OPTED_OUT",
  };
  return new WhatsAppPolicyError(publicCodes[databaseCode] ?? databaseCode);
}

function recordedMessage(
  row: Record<string, unknown>,
  deduplicated: boolean,
): RecordedMessage {
  return {
    id: row.id as string,
    whatsapp_message_id: (row.whatsapp_message_id as string | null) ?? null,
    status: row.status as RecordedMessage["status"],
    deduplicated,
  };
}

function completedExistingMessage(
  row: Record<string, unknown>,
): RecordedMessage {
  const disposition = existingWhatsAppDispatchDisposition(row);
  if (disposition === "completed") return recordedMessage(row, true);
  if (disposition === "in_progress") {
    throw new WhatsAppDispatchError("OUTBOUND_DISPATCH_IN_PROGRESS", {
      retryable: true,
    });
  }
  throw new WhatsAppDispatchError("PREVIOUS_SEND_FAILED", {
    retryable: disposition === "retryable_failure",
  });
}

async function assertTestRecipientAllowed(args: {
  client: SupabaseClient;
  conversation: WhatsAppConversation;
  contact: WhatsAppContact;
  recipient: string;
  sentBy: string | null;
  source: string | null;
  type: "text" | "template" | "interactive";
}): Promise<void> {
  const { client, conversation, contact, recipient, sentBy, source, type } =
    args;
  if (!whatsappTestModeEnabled()) return;

  const allowedNumbers = Deno.env.get("WHATSAPP_TEST_ALLOWED_NUMBERS");
  if (isWhatsAppTestRecipientAllowed(recipient, "true", allowedNumbers)) return;

  const { error: auditError } = await client.from("audit_logs").insert({
    actor_user_id: sentBy,
    action: "whatsapp.test_mode_blocked",
    entity_type: "contact",
    entity_id: contact.id,
    metadata: {
      conversation_id: conversation.id,
      source: source ?? "unknown",
      message_type: type,
      reason: "TEST_RECIPIENT_NOT_ALLOWED",
    },
  });

  console.warn("WhatsApp outbound blocked by test mode", {
    code: "TEST_RECIPIENT_NOT_ALLOWED",
    contactId: contact.id,
    conversationId: conversation.id,
    source: source ?? "unknown",
    auditRecorded: !auditError,
  });
  throw new WhatsAppPolicyError("TEST_RECIPIENT_NOT_ALLOWED");
}

async function pauseAutomationForManualDispatch(args: {
  client: SupabaseClient;
  conversation: WhatsAppConversation;
  contact: WhatsAppContact;
  source: string | null;
}): Promise<void> {
  const { client, conversation, contact, source } = args;
  if (!isOperatorWhatsAppSource(source)) return;

  // Claim human control before the external send. Automation dispatches query
  // this fresh value immediately before Graph, closing the common bot/operator
  // race instead of waiting until after the manual message was accepted.
  const { data, error } = await client
    .from("conversations")
    .update({
      automation_mode: "manual",
      automation_pause_source: "operator",
      automation_pause_message_id: null,
    })
    .eq("id", conversation.id)
    .eq("contact_id", contact.id)
    .select("id")
    .maybeSingle();
  if (error || !data) throw new Error("MANUAL_HANDOFF_FAILED");
}

export async function sendAndRecordMessage(args: {
  client: SupabaseClient;
  conversation: WhatsAppConversation;
  contact: WhatsAppContact;
  payload: Record<string, unknown>;
  bodyPreview: string;
  idempotencyKey: string;
  sentBy?: string | null;
  templateName?: string | null;
  templateKey?: string | null;
  appointmentId?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<RecordedMessage> {
  const {
    client,
    conversation,
    contact,
    payload,
    bodyPreview,
    idempotencyKey,
    sentBy = null,
    templateName = null,
    templateKey = null,
    appointmentId = null,
    metadata = {},
  } = args;

  const type = messageTypeFromPayload(payload);
  const source = typeof metadata.source === "string" ? metadata.source : null;
  const automationOwnerMessageId =
    typeof metadata.inbound_message_id === "string"
      ? metadata.inbound_message_id
      : null;
  const recipient = whatsappRecipient(contact);
  assertAdministrativePayload(bodyPreview, payload);
  if (!validIdempotencyKey(idempotencyKey)) {
    throw new Error("INVALID_IDEMPOTENCY_KEY");
  }
  if (!bodyPreview || bodyPreview.length > 4096) {
    throw new Error("INVALID_MESSAGE_BODY");
  }

  const interactiveOptions = interactiveOptionsFromPayload(payload);
  const complianceMetadata: Record<string, unknown> = {
    ...metadata,
    ...(interactiveOptions.length
      ? { interactive_options: interactiveOptions }
      : {}),
    ...(type === "template"
      ? { template_key: templateKey, appointment_id: appointmentId }
      : {}),
  };

  const existingResult = await client
    .from("messages")
    .select(
      "id,conversation_id,contact_id,whatsapp_message_id,type,body,template_name,status,metadata",
    )
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();
  if (existingResult.error) {
    throw new Error(`MESSAGE_LOOKUP_FAILED:${existingResult.error.message}`);
  }

  const assertExistingMatches = (row: Record<string, unknown>) => {
    const rowMetadata = (row.metadata ?? {}) as Record<string, unknown>;
    if (
      row.conversation_id !== conversation.id ||
      row.contact_id !== contact.id ||
      row.type !== type ||
      row.body !== bodyPreview ||
      (row.template_name ?? null) !== templateName ||
      (rowMetadata.source ?? null) !== source ||
      (appointmentId !== null &&
        rowMetadata.appointment_id !== appointmentId) ||
      (type === "template" &&
        (rowMetadata.template_key !== templateKey ||
          rowMetadata.appointment_id !== appointmentId))
    ) {
      throw new Error("IDEMPOTENCY_CONFLICT");
    }
  };

  if (existingResult.data) {
    const existing = existingResult.data as Record<string, unknown>;
    assertExistingMatches(existing);
    if (existingWhatsAppDispatchDisposition(existing) !== "retryable_failure") {
      return completedExistingMessage(existing);
    }
  }

  await assertTestRecipientAllowed({
    client,
    conversation,
    contact,
    recipient,
    sentBy,
    source,
    type,
  });
  await pauseAutomationForManualDispatch({
    client,
    conversation,
    contact,
    source,
  });

  await assertOutboundPolicy({
    client,
    conversation,
    contact,
    type,
    templateName,
    templateKey,
    appointmentId,
    source,
    automationOwnerMessageId,
  });

  let pending: Record<string, unknown> | null = null;
  if (existingResult.data) {
    const existing = existingResult.data as Record<string, unknown>;
    const existingMetadata = (existing.metadata ?? {}) as Record<
      string,
      unknown
    >;
    const attempts = Number(existingMetadata.send_attempts ?? 1);
    const retryMetadata = {
      ...existingMetadata,
      ...complianceMetadata,
      send_attempts: attempts + 1,
      error: null,
      error_code: null,
      error_subcode: null,
      error_retryable: null,
    };
    const retryClaim = await client
      .from("messages")
      .update({ status: "pending", metadata: retryMetadata })
      .eq("id", existing.id)
      .eq("status", "failed")
      .select("id,whatsapp_message_id,status,metadata")
      .maybeSingle();
    if (retryClaim.error) {
      throw new Error(`MESSAGE_RETRY_CLAIM_FAILED:${retryClaim.error.message}`);
    }
    if (!retryClaim.data) {
      const raced = await client
        .from("messages")
        .select("id,whatsapp_message_id,status,metadata")
        .eq("id", existing.id)
        .single();
      if (raced.error || !raced.data) {
        throw new Error("MESSAGE_RETRY_CLAIM_FAILED");
      }
      return completedExistingMessage(raced.data as Record<string, unknown>);
    }
    pending = retryClaim.data as Record<string, unknown>;
  } else {
    const insertResult = await client
      .from("messages")
      .insert({
        conversation_id: conversation.id,
        contact_id: contact.id,
        direction: "outbound",
        type,
        body: bodyPreview,
        template_name: templateName,
        status: "pending",
        sent_by: sentBy,
        idempotency_key: idempotencyKey,
        metadata: { ...complianceMetadata, send_attempts: 1 },
      })
      .select("id,whatsapp_message_id,status,metadata")
      .single();

    if (insertResult.error || !insertResult.data) {
      if (insertResult.error?.code === "23505") {
        const raced = await client
          .from("messages")
          .select(
            "id,conversation_id,contact_id,whatsapp_message_id,type,body,template_name,status,metadata",
          )
          .eq("idempotency_key", idempotencyKey)
          .single();
        if (raced.error || !raced.data) {
          throw new Error("MESSAGE_IDEMPOTENCY_LOOKUP_FAILED");
        }
        assertExistingMatches(raced.data as Record<string, unknown>);
        return completedExistingMessage(raced.data as Record<string, unknown>);
      }
      const policyError = insertResult.error
        ? policyErrorFromDatabase(insertResult.error.message)
        : null;
      if (policyError) throw policyError;
      throw new Error(
        `MESSAGE_INSERT_FAILED:${insertResult.error?.message ?? "unknown"}`,
      );
    }
    pending = insertResult.data as Record<string, unknown>;
  }

  if (!pending) throw new Error("MESSAGE_RESERVATION_FAILED");

  let metaAccepted = false;
  let acceptedMessageId: string | null = null;
  try {
    // Re-evaluate immediately before the external side effect. This protects
    // delayed automation/retries and changes to consent or the service window.
    await assertOutboundPolicy({
      client,
      conversation,
      contact,
      type,
      templateName,
      templateKey,
      appointmentId,
      source,
      automationOwnerMessageId,
    });
    await assertTestRecipientAllowed({
      client,
      conversation,
      contact,
      recipient,
      sentBy,
      source,
      type,
    });
    assertAdministrativePayload(bodyPreview, payload);
    const dispatched = await dispatchWhatsAppPayload({
      recipient,
      payload,
      opaqueMessageId: pending.id as string,
    });
    const whatsappMessageId = dispatched.whatsappMessageId;
    metaAccepted = true;
    acceptedMessageId = whatsappMessageId;

    const { error: updateError } = await client
      .from("messages")
      .update({
        whatsapp_message_id: whatsappMessageId,
        status: "sent",
        metadata: {
          ...(pending.metadata && typeof pending.metadata === "object"
            ? (pending.metadata as Record<string, unknown>)
            : {}),
          ...complianceMetadata,
          send_attempts:
            pending.metadata && typeof pending.metadata === "object"
              ? ((pending.metadata as Record<string, unknown>).send_attempts ??
                1)
              : 1,
          meta_request_id: dispatched.requestId,
        },
      })
      .eq("id", pending.id);
    if (updateError) {
      throw new WhatsAppDispatchError("MESSAGE_UPDATE_FAILED", {
        message: updateError.message.slice(0, 300),
        retryable: false,
      });
    }

    return {
      id: pending.id as string,
      whatsapp_message_id: whatsappMessageId,
      status: "sent",
      deduplicated: false,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message.slice(0, 500) : "SEND_FAILED";
    const retryable =
      error instanceof WhatsAppDispatchError
        ? error.retryable
        : error instanceof Error &&
          error.message.startsWith("CONFIGURATION_INCOMPLETE");
    const graphCode =
      error instanceof WhatsAppDispatchError ? error.graphCode : null;
    const graphSubcode =
      error instanceof WhatsAppDispatchError ? error.graphSubcode : null;
    const previousMetadata =
      pending.metadata && typeof pending.metadata === "object"
        ? (pending.metadata as Record<string, unknown>)
        : {};

    if (metaAccepted && acceptedMessageId) {
      // Never retry an accepted-but-not-persisted request. The opaque callback
      // lets the status webhook reconcile this logical message later.
      await client
        .from("messages")
        .update({
          whatsapp_message_id: acceptedMessageId,
          status: "sent",
          metadata: {
            ...previousMetadata,
            ...complianceMetadata,
            persistence_warning: message,
            error_retryable: false,
          },
        })
        .eq("id", pending.id);
    } else {
      await client
        .from("messages")
        .update({
          status: "failed",
          metadata: {
            ...previousMetadata,
            ...complianceMetadata,
            error: message,
            error_code: graphCode,
            error_subcode: graphSubcode,
            error_retryable: retryable,
          },
        })
        .eq("id", pending.id);
    }
    throw error;
  }
}

export const DEFAULT_BUSINESS_TIMEZONE = "America/Argentina/Buenos_Aires";

export function formatAppointmentDate(
  value: string,
  timeZone = DEFAULT_BUSINESS_TIMEZONE,
): string {
  return new Intl.DateTimeFormat("es-AR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone,
  }).format(new Date(value));
}

export function formatAppointmentTime(
  value: string,
  timeZone = DEFAULT_BUSINESS_TIMEZONE,
): string {
  return new Intl.DateTimeFormat("es-AR", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
  }).format(new Date(value));
}
