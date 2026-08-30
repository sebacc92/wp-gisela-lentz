import type { SupabaseClient } from "npm:@supabase/supabase-js@2.112.2";
import {
  isWhatsAppCredentialResolutionError,
  resolveWhatsAppAccountCredentials,
  type WhatsAppAccountCredentials,
} from "./whatsapp-account-credentials.ts";

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
  coexistence_account_id?: string | null;
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
    code?: number;
    error_subcode?: number;
    is_transient?: boolean;
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
  readonly credentialInvalid: boolean;

  constructor(
    code: string,
    options: {
      message?: string;
      retryable?: boolean;
      graphCode?: number | null;
      graphSubcode?: number | null;
      credentialInvalid?: boolean;
    } = {},
  ) {
    super(options.message ? `${code}:${options.message}` : code);
    this.name = "WhatsAppDispatchError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.graphCode = options.graphCode ?? null;
    this.graphSubcode = options.graphSubcode ?? null;
    this.credentialInvalid = options.credentialInvalid ?? false;
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
  const normalized = message.toUpperCase();
  if (normalized.includes("WHATSAPP_AUTOMATION_EFFECT_BLOCKED_MANUAL")) {
    return "AUTOMATION_PAUSED";
  }
  if (normalized.includes("WHATSAPP_AUTOMATION_EFFECT_BLOCKED_HUMAN_REPLY")) {
    return "AUTOMATION_SUPERSEDED_BY_HUMAN_REPLY";
  }
  return null;
}

export function shouldRetryWhatsAppError(error: unknown): boolean {
  if (error instanceof WhatsAppPolicyError) return false;
  if (error instanceof WhatsAppDispatchError) return error.retryable;
  if (!(error instanceof Error)) return false;
  return (
    error.message.startsWith("CONFIGURATION_INCOMPLETE") ||
    error.message === "WHATSAPP_CREDENTIAL_RESOLUTION_FAILED" ||
    error.message.startsWith("WHATSAPP_CREDENTIAL_CONFIGURATION_MISSING") ||
    error.message.startsWith("MESSAGE_INSERT_FAILED")
  );
}

/**
 * Automation execution leases must distinguish a temporary credential lookup
 * failure from a generation/account barrier. Treating every resolver error as
 * retryable can leave a failed execution permanently blocking its conversation
 * after offboarding has already terminalized the dispatch.
 */
export function isRetryableWhatsAppAutomationFailure(error: unknown): boolean {
  if (isWhatsAppCredentialResolutionError(error)) return error.retryable;
  if (error instanceof WhatsAppDispatchError) return error.retryable;

  const message =
    error instanceof Error ? error.message.toUpperCase() : "ERROR INESPERADO";
  return !["_INVALID", "_CONFLICT", "_NOT_FOUND", "_UNSUPPORTED"].some(
    (marker) => message.includes(marker),
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

export type WhatsAppRecipientIdentityKind = "wa_id" | "phone" | "bsuid";

export interface WhatsAppRecipientIdentity {
  value: string;
  kind: WhatsAppRecipientIdentityKind;
  provenance: "coexistence_mapping" | "recent_inbound" | "legacy";
}

export function whatsappRecipientIdentity(contact: WhatsAppContact): {
  value: string;
  kind: WhatsAppRecipientIdentityKind;
} {
  const whatsappId = contact.whatsapp_id?.trim() ?? "";
  if (/^[1-9][0-9]{7,14}$/.test(whatsappId)) {
    return { value: whatsappId, kind: "wa_id" };
  }

  const phone = contact.phone_e164
    ? normalizeWhatsAppNumber(contact.phone_e164)
    : null;
  if (phone) return { value: phone, kind: "phone" };

  const businessScopedUserId = contact.whatsapp_user_id?.trim() ?? "";
  if (businessScopedUserId) {
    return { value: businessScopedUserId, kind: "bsuid" };
  }

  throw new WhatsAppPolicyError("CONTACT_IDENTITY_MISSING");
}

export function whatsappRecipient(contact: WhatsAppContact): string {
  return whatsappRecipientIdentity(contact).value;
}

function firstRecipientRpcRow(value: unknown): Record<string, unknown> | null {
  const row = Array.isArray(value) ? value[0] : value;
  return row && typeof row === "object" && !Array.isArray(row)
    ? (row as Record<string, unknown>)
    : null;
}

export async function resolveWhatsAppRecipientIdentity(args: {
  client: SupabaseClient;
  contact: WhatsAppContact;
  conversation: WhatsAppConversation;
  credentials: WhatsAppAccountCredentials;
}): Promise<WhatsAppRecipientIdentity> {
  if (args.credentials.credentialMode === "legacy") {
    return { ...whatsappRecipientIdentity(args.contact), provenance: "legacy" };
  }
  if (!args.credentials.accountId) {
    throw new WhatsAppPolicyError("CONTACT_IDENTITY_UNVERIFIED");
  }

  const result = await args.client.rpc(
    "resolve_whatsapp_coexistence_recipient",
    {
      p_account_id: args.credentials.accountId,
      p_conversation_id: args.conversation.id,
      p_contact_id: args.contact.id,
    },
  );
  if (result.error) {
    throw new WhatsAppPolicyError("CONTACT_IDENTITY_UNVERIFIED");
  }
  const row = firstRecipientRpcRow(result.data);
  const value =
    typeof row?.recipient_value === "string" ? row.recipient_value.trim() : "";
  const kind = row?.identity_kind;
  const provenance = row?.identity_provenance;
  const validValue =
    kind === "bsuid"
      ? /^[A-Za-z0-9.]{1,256}$/.test(value)
      : /^[1-9][0-9]{7,14}$/.test(value);
  if (
    !validValue ||
    (kind !== "wa_id" && kind !== "phone" && kind !== "bsuid") ||
    (provenance !== "coexistence_mapping" && provenance !== "recent_inbound")
  ) {
    throw new WhatsAppPolicyError("CONTACT_IDENTITY_UNVERIFIED");
  }
  return {
    value,
    kind,
    provenance,
  };
}

function runtimeSecret(name: string): string | null {
  const value =
    typeof Deno !== "undefined"
      ? Deno.env.get(name)
      : (
          globalThis as typeof globalThis & {
            process?: { env?: Record<string, string | undefined> };
          }
        ).process?.env?.[name];
  const clean = value?.trim() ?? "";
  return clean && !/[\r\n]/.test(clean) ? clean : null;
}

export async function whatsappRecipientFingerprint(args: {
  identity: Pick<WhatsAppRecipientIdentity, "kind" | "value">;
  accountId: string | null;
  idempotencyKey: string;
  secret?: string;
}): Promise<string> {
  const secret =
    args.secret?.trim() ||
    runtimeSecret("WHATSAPP_RECIPIENT_FINGERPRINT_SECRET") ||
    runtimeSecret("META_APP_SECRET");
  if (!secret || /[\r\n]/.test(secret)) {
    throw new Error("WHATSAPP_RECIPIENT_FINGERPRINT_SECRET_MISSING");
  }
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const payload = [
    "whatsapp-recipient-idempotency:v1",
    args.accountId ?? "legacy",
    args.idempotencyKey,
    args.identity.kind,
    args.identity.value,
  ].join("\u0000");
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function assertWhatsAppRecipientSnapshot(args: {
  metadata: Record<string, unknown>;
  fingerprint: string;
  kind: WhatsAppRecipientIdentityKind;
  required: boolean;
}): void {
  const existingFingerprint = args.metadata.recipient_fingerprint;
  if (
    typeof existingFingerprint === "string" &&
    existingFingerprint !== args.fingerprint
  ) {
    throw new Error("IDEMPOTENCY_CONFLICT");
  }
  if (
    args.required &&
    (existingFingerprint !== args.fingerprint ||
      args.metadata.recipient_fingerprint_version !== 1 ||
      args.metadata.recipient_identity_kind !== args.kind)
  ) {
    throw new Error("IDEMPOTENCY_RECIPIENT_UNVERIFIABLE");
  }
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
    value === "owner_access" ||
    value === "reminder" ||
    value === "deposit_request" ||
    value === "deposit_confirmation" ||
    value === "proof_acknowledgement" ||
    value === "late_proof_acknowledgement" ||
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
      args.source === "proof_acknowledgement" ||
      args.source === "late_proof_acknowledgement") &&
    args.pauseSource === "inbound_handoff" &&
    Boolean(args.inboundMessageId) &&
    args.pauseMessageId === args.inboundMessageId
  );
}

export type DepositProofAcknowledgementSource =
  | "proof_acknowledgement"
  | "late_proof_acknowledgement";

export function isCurrentDepositProofAcknowledgement(args: {
  source: DepositProofAcknowledgementSource;
  automationOwnerMessageId: string | null;
  appointment: {
    status: string;
    deposit_status: string;
    deposit_proof_late: boolean | null;
    deposit_proof_message_id: string | null;
  };
}): boolean {
  const { appointment } = args;
  if (
    !args.automationOwnerMessageId ||
    appointment.deposit_proof_message_id !== args.automationOwnerMessageId
  ) {
    return false;
  }
  return args.source === "proof_acknowledgement"
    ? appointment.status === "scheduled" &&
        appointment.deposit_status === "proof_received" &&
        appointment.deposit_proof_late !== true
    : appointment.status === "cancelled" &&
        appointment.deposit_status === "expired" &&
        appointment.deposit_proof_late === true;
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

function whatsappTestModeEnabled(): boolean {
  return parseSafetyBoolean(Deno.env.get("WHATSAPP_TEST_MODE"), true);
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
          "id,contact_id,last_inbound_message_at,automation_mode,automation_pause_source,automation_pause_message_id,automation_human_barrier_ingest_sequence",
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
    automation_human_barrier_ingest_sequence: number;
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
    if (automationOwnerMessageId) {
      const ownerResult = await client
        .from("messages")
        .select("whatsapp_ingest_sequence")
        .eq("id", automationOwnerMessageId)
        .eq("conversation_id", freshConversation.id)
        .eq("direction", "inbound")
        .maybeSingle();
      const ownerSequence = Number(
        ownerResult.data?.whatsapp_ingest_sequence ?? Number.NaN,
      );
      const barrierSequence = Number(
        freshConversation.automation_human_barrier_ingest_sequence,
      );
      if (
        ownerResult.error ||
        !Number.isSafeInteger(ownerSequence) ||
        !Number.isSafeInteger(barrierSequence)
      ) {
        throw new WhatsAppPolicyError("AUTOMATION_OWNER_CONTEXT_INVALID");
      }
      if (ownerSequence <= barrierSequence) {
        throw new WhatsAppPolicyError("AUTOMATION_SUPERSEDED_BY_HUMAN_REPLY");
      }
    }
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
      source === "deposit_confirmation" ||
      source === "proof_acknowledgement" ||
      source === "late_proof_acknowledgement" ||
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
          "id,contact_id,status,deposit_status,deposit_proof_late,deposit_proof_message_id,hold_expires_at,hold_expired_notification_status",
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
        source === "deposit_confirmation" &&
        (appointment.status !== "confirmed" ||
          appointment.deposit_status !== "confirmed" ||
          !automationOwnerMessageId ||
          appointment.deposit_proof_message_id !== automationOwnerMessageId)
      ) {
        throw new WhatsAppPolicyError("DEPOSIT_CONFIRMATION_STALE");
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
        source === "proof_acknowledgement" ||
        source === "late_proof_acknowledgement"
      ) {
        if (
          !isCurrentDepositProofAcknowledgement({
            source,
            automationOwnerMessageId,
            appointment,
          })
        ) {
          throw new WhatsAppPolicyError(
            source === "proof_acknowledgement"
              ? "DEPOSIT_PROOF_ACKNOWLEDGEMENT_STALE"
              : "LATE_DEPOSIT_PROOF_ACKNOWLEDGEMENT_STALE",
          );
        }
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
  const credentialInvalid = responseStatus === 401 || graphCode === 190;
  const isPolicyError =
    graphCode !== null && NON_RETRYABLE_POLICY_GRAPH_CODES.has(graphCode);
  const retryable =
    !credentialInvalid &&
    !isPolicyError &&
    (result.error?.is_transient === true ||
      responseStatus === 429 ||
      (graphCode !== null && RETRYABLE_GRAPH_CODES.has(graphCode)));
  return new WhatsAppDispatchError(
    credentialInvalid
      ? "META_AUTHENTICATION_FAILED"
      : isPolicyError
        ? "META_POLICY_REJECTED"
        : "META_SEND_FAILED",
    {
      retryable,
      graphCode,
      graphSubcode,
      credentialInvalid,
    },
  );
}

export async function dispatchWhatsAppPayload(args: {
  recipient: string;
  recipientKind?: WhatsAppRecipientIdentityKind;
  payload: Record<string, unknown>;
  opaqueMessageId: string;
  credentials: WhatsAppAccountCredentials;
  fetchImpl?: typeof fetch;
}): Promise<{ whatsappMessageId: string; requestId: string | null }> {
  const outboundPayload = { ...args.payload };
  delete outboundPayload.messaging_product;
  delete outboundPayload.recipient_type;
  delete outboundPayload.to;
  delete outboundPayload.recipient;
  delete outboundPayload.biz_opaque_callback_data;
  const response = await (args.fetchImpl ?? fetch)(
    `https://graph.facebook.com/${args.credentials.apiVersion}/${args.credentials.phoneNumberId}/messages`,
    {
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${args.credentials.businessAccessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...outboundPayload,
        messaging_product: "whatsapp",
        recipient_type: "individual",
        ...(args.recipientKind === "bsuid"
          ? { recipient: args.recipient }
          : { to: args.recipient }),
        biz_opaque_callback_data: args.opaqueMessageId,
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

export async function markWhatsAppCredentialAttentionRequired(input: {
  client: SupabaseClient;
  credentials: WhatsAppAccountCredentials;
  observedAt?: string;
}): Promise<boolean> {
  if (
    input.credentials.credentialMode !== "coexistence" ||
    !input.credentials.accountId ||
    !input.credentials.tokenGeneration
  ) {
    return false;
  }
  const result = await input.client.rpc(
    "mark_whatsapp_business_token_attention_required",
    {
      p_account_id: input.credentials.accountId,
      p_expected_token_generation: input.credentials.tokenGeneration,
      p_token_status: "unknown",
      p_error_code: "META_AUTHENTICATION_FAILED",
      p_observed_at: input.observedAt ?? new Date().toISOString(),
    },
  );
  if (result.error || result.data !== true) {
    console.error("WhatsApp credential attention state was not persisted", {
      code: "WHATSAPP_TOKEN_ATTENTION_PERSIST_FAILED",
      accountId: input.credentials.accountId,
    });
    return false;
  }
  return true;
}

export function isMetaGraphAuthenticationFailure(
  responseStatus: number,
  payload: unknown,
): boolean {
  if (responseStatus === 401) return true;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }
  const error = (payload as { error?: unknown }).error;
  return (
    Boolean(error) &&
    typeof error === "object" &&
    !Array.isArray(error) &&
    (error as { code?: unknown }).code === 190
  );
}

export async function observeMetaGraphAuthenticationFailure(input: {
  client: SupabaseClient;
  credentials: WhatsAppAccountCredentials;
  response: Response;
}): Promise<boolean> {
  let payload: unknown = null;
  try {
    payload = await input.response.clone().json();
  } catch {
    // HTTP 401 is sufficient evidence even if Graph returned no JSON body.
  }
  if (!isMetaGraphAuthenticationFailure(input.response.status, payload)) {
    return false;
  }
  await markWhatsAppCredentialAttentionRequired({
    client: input.client,
    credentials: input.credentials,
  });
  return true;
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
  coexistenceAccountId?: string | null;
  metadata?: Record<string, unknown>;
  fetchImpl?: typeof fetch;
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
    coexistenceAccountId = null,
    metadata = {},
    fetchImpl,
  } = args;

  const type = messageTypeFromPayload(payload);
  const source = typeof metadata.source === "string" ? metadata.source : null;
  const automationOwnerMessageId =
    typeof metadata.inbound_message_id === "string"
      ? metadata.inbound_message_id
      : null;
  assertAdministrativePayload(bodyPreview, payload);
  if (!validIdempotencyKey(idempotencyKey)) {
    throw new Error("INVALID_IDEMPOTENCY_KEY");
  }
  if (!bodyPreview || bodyPreview.length > 4096) {
    throw new Error("INVALID_MESSAGE_BODY");
  }
  if (
    coexistenceAccountId !== null &&
    conversation.coexistence_account_id != null &&
    coexistenceAccountId !== conversation.coexistence_account_id
  ) {
    throw new WhatsAppPolicyError("WHATSAPP_ACCOUNT_CONTEXT_CONFLICT");
  }
  const initialCredentials = await resolveWhatsAppAccountCredentials({
    client,
    purpose: "send",
    coexistenceAccountId:
      coexistenceAccountId ?? conversation.coexistence_account_id ?? null,
    conversationId: conversation.id,
  });
  const recipientIdentity = await resolveWhatsAppRecipientIdentity({
    client,
    contact,
    conversation,
    credentials: initialCredentials,
  });
  const recipient = recipientIdentity.value;
  const recipientFingerprint = await whatsappRecipientFingerprint({
    identity: recipientIdentity,
    accountId: initialCredentials.accountId,
    idempotencyKey,
  });

  const interactiveOptions = interactiveOptionsFromPayload(payload);
  const complianceMetadata: Record<string, unknown> = {
    ...metadata,
    recipient_identity_kind: recipientIdentity.kind,
    recipient_identity_provenance: recipientIdentity.provenance,
    recipient_fingerprint_version: 1,
    recipient_fingerprint: recipientFingerprint,
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
      "id,conversation_id,contact_id,coexistence_account_id,whatsapp_message_id,type,body,template_name,status,metadata",
    )
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();
  if (existingResult.error) {
    throw new Error(`MESSAGE_LOOKUP_FAILED:${existingResult.error.message}`);
  }

  const assertExistingMatches = (
    row: Record<string, unknown>,
    requireRecipientSnapshot: boolean,
  ) => {
    const rowMetadata = (row.metadata ?? {}) as Record<string, unknown>;
    if (
      row.conversation_id !== conversation.id ||
      row.contact_id !== contact.id ||
      (row.coexistence_account_id ?? null) !== initialCredentials.accountId ||
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
    assertWhatsAppRecipientSnapshot({
      metadata: rowMetadata,
      fingerprint: recipientFingerprint,
      kind: recipientIdentity.kind,
      required: requireRecipientSnapshot,
    });
  };

  if (existingResult.data) {
    const existing = existingResult.data as Record<string, unknown>;
    const disposition = existingWhatsAppDispatchDisposition(existing);
    assertExistingMatches(existing, disposition === "retryable_failure");
    if (disposition !== "retryable_failure") {
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
      recipient_identity_kind: existingMetadata.recipient_identity_kind,
      recipient_identity_provenance:
        existingMetadata.recipient_identity_provenance,
      recipient_fingerprint_version:
        existingMetadata.recipient_fingerprint_version,
      recipient_fingerprint: existingMetadata.recipient_fingerprint,
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
        coexistence_account_id: initialCredentials.accountId,
        metadata: { ...complianceMetadata, send_attempts: 1 },
      })
      .select("id,whatsapp_message_id,status,metadata")
      .single();

    if (insertResult.error || !insertResult.data) {
      if (insertResult.error?.code === "23505") {
        const raced = await client
          .from("messages")
          .select(
            "id,conversation_id,contact_id,coexistence_account_id,whatsapp_message_id,type,body,template_name,status,metadata",
          )
          .eq("idempotency_key", idempotencyKey)
          .single();
        if (raced.error || !raced.data) {
          throw new Error("MESSAGE_IDEMPOTENCY_LOOKUP_FAILED");
        }
        assertExistingMatches(raced.data as Record<string, unknown>, false);
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
    const currentRecipientIdentity = await resolveWhatsAppRecipientIdentity({
      client,
      contact,
      conversation,
      credentials: initialCredentials,
    });
    const currentRecipientFingerprint = await whatsappRecipientFingerprint({
      identity: currentRecipientIdentity,
      accountId: initialCredentials.accountId,
      idempotencyKey,
    });
    if (
      currentRecipientFingerprint !== recipientFingerprint ||
      currentRecipientIdentity.kind !== recipientIdentity.kind
    ) {
      throw new WhatsAppPolicyError("WHATSAPP_RECIPIENT_CONTEXT_CHANGED");
    }
    const credentials = await resolveWhatsAppAccountCredentials({
      client,
      purpose: "send",
      coexistenceAccountId: initialCredentials.accountId,
      wabaId: initialCredentials.wabaId,
      phoneNumberId: initialCredentials.phoneNumberId,
      conversationId: conversation.id,
      expectedTokenGeneration: initialCredentials.tokenGeneration,
    });
    if (
      credentials.credentialMode !== initialCredentials.credentialMode ||
      credentials.accountId !== initialCredentials.accountId
    ) {
      throw new WhatsAppPolicyError("WHATSAPP_ACCOUNT_CONTEXT_CHANGED");
    }
    const dispatched = await dispatchWhatsAppPayload({
      recipient,
      recipientKind: recipientIdentity.kind,
      payload,
      opaqueMessageId: pending.id as string,
      credentials,
      fetchImpl,
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
    if (
      error instanceof WhatsAppDispatchError &&
      error.credentialInvalid &&
      initialCredentials.credentialMode === "coexistence" &&
      initialCredentials.accountId &&
      initialCredentials.tokenGeneration
    ) {
      await markWhatsAppCredentialAttentionRequired({
        client,
        credentials: initialCredentials,
      });
    }
    const message =
      error instanceof Error ? error.message.slice(0, 500) : "SEND_FAILED";
    const retryable =
      error instanceof WhatsAppDispatchError
        ? error.retryable
        : isWhatsAppCredentialResolutionError(error)
          ? error.retryable
          : error instanceof Error &&
            (error.message.startsWith("CONFIGURATION_INCOMPLETE") ||
              error.message === "WHATSAPP_CREDENTIAL_RESOLUTION_FAILED" ||
              error.message.startsWith(
                "WHATSAPP_CREDENTIAL_CONFIGURATION_MISSING",
              ));
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
