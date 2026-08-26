export type MetaJson = Record<string, unknown>;

export interface MetaMessage extends MetaJson {
  id: string;
  from?: string;
  from_user_id?: string;
  to?: string;
  to_user_id?: string;
  timestamp?: string | number;
  type?: string;
  text?: { body?: string };
  button?: { payload?: string; text?: string };
  interactive?: {
    type?: string;
    button_reply?: { id?: string; title?: string };
    list_reply?: { id?: string; title?: string; description?: string };
  };
  image?: { id?: string; caption?: string; mime_type?: string };
  document?: {
    id?: string;
    caption?: string;
    filename?: string;
    mime_type?: string;
  };
}

export interface MetaStatus extends MetaJson {
  id: string;
  status: "sent" | "delivered" | "read" | "played" | "failed";
  timestamp?: string | number;
  recipient_id?: string;
  recipient_user_id?: string;
  errors?: Array<{ code?: number; title?: string; message?: string }>;
}

export interface MetaValue extends MetaJson {
  messaging_product?: string;
  metadata?: {
    display_phone_number?: string;
    phone_number_id?: string;
  };
  contacts?: Array<{
    profile?: {
      name?: string;
      username?: string;
      country_code?: string;
    };
    wa_id?: string;
    user_id?: string;
  }>;
  messages?: MetaMessage[];
  statuses?: MetaStatus[];
  history?: unknown[];
  state_sync?: unknown[];
  message_echoes?: unknown[];
  event?: string;
  status?: string;
  decision?: string;
  quality_rating?: string;
  quality_score?: string;
  current_limit?: string | number;
  phone_number_id?: string;
  message_template_id?: string | number;
  message_template_name?: string;
  message_template_language?: string;
  reason?: string;
  ban_info?: { waba_ban_state?: string; waba_ban_date?: string };
}

export interface MetaChange {
  field?: string;
  value?: MetaValue;
}

export interface MetaWebhook {
  object?: string;
  entry?: Array<{
    id?: string;
    changes?: MetaChange[];
  }>;
}

export const COEXISTENCE_FIELDS = new Set([
  "history",
  "smb_app_state_sync",
  "smb_message_echoes",
]);

export const OPERATIONAL_FIELDS = new Set([
  "phone_number_quality_update",
  "account_update",
  "account_review_update",
  "business_capability_update",
  "message_template_status_update",
  "message_template_quality_update",
]);

export const DEFAULT_WHATSAPP_WEBHOOK_MAX_BYTES = 3 * 1024 * 1024;
const MAXIMUM_CONFIGURABLE_WEBHOOK_BYTES = 16 * 1024 * 1024;

export class WhatsAppWebhookPayloadTooLargeError extends Error {
  constructor() {
    super("WHATSAPP_WEBHOOK_PAYLOAD_TOO_LARGE");
    this.name = "WhatsAppWebhookPayloadTooLargeError";
  }
}

export function configuredWebhookBodyLimit(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) &&
    parsed >= 64 * 1024 &&
    parsed <= MAXIMUM_CONFIGURABLE_WEBHOOK_BYTES
    ? parsed
    : DEFAULT_WHATSAPP_WEBHOOK_MAX_BYTES;
}

export async function readWhatsAppWebhookBody(
  request: Request,
  maximumBytes: number,
): Promise<Uint8Array> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new WhatsAppWebhookPayloadTooLargeError();
  }
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel("payload too large");
        throw new WhatsAppWebhookPayloadTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export function decodeWhatsAppWebhookBody(body: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(body);
}

const PHONE_SCOPED_FIELDS = new Set(["messages", ...COEXISTENCE_FIELDS]);

export type WhatsAppChangeRoute =
  | "messages"
  | "coexistence"
  | "operational"
  | "unknown";

export function routeWhatsAppChange(field: string): WhatsAppChangeRoute {
  if (field === "messages") return "messages";
  if (COEXISTENCE_FIELDS.has(field)) return "coexistence";
  if (OPERATIONAL_FIELDS.has(field)) return "operational";
  return "unknown";
}

export function isExpectedWhatsAppBusinessAccount(
  entryId: unknown,
  expectedWabaId: string,
): entryId is string {
  return typeof entryId === "string" && entryId === expectedWabaId;
}

export function hexadecimal(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

export function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let result = 0;
  for (let index = 0; index < left.length; index += 1) {
    result |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return result === 0;
}

export async function verifyMetaSignature(
  rawBody: Uint8Array | string,
  signature: string,
  appSecret: string,
): Promise<boolean> {
  if (!appSecret || !signature.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const source =
    typeof rawBody === "string" ? new TextEncoder().encode(rawBody) : rawBody;
  const exactBytes = new Uint8Array(source.byteLength);
  exactBytes.set(source);
  const digest = await crypto.subtle.sign("HMAC", key, exactBytes.buffer);
  return constantTimeEqual(`sha256=${hexadecimal(digest)}`, signature);
}

export async function metaChangeEventId(
  entryId: string,
  field: string,
  value: MetaValue,
): Promise<string> {
  const bytes = new TextEncoder().encode(
    JSON.stringify({ entryId, field, value }),
  );
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `change:${field}:${hexadecimal(digest)}`;
}

export function isTrustedWhatsAppChange(
  field: string,
  value: MetaValue,
  expectedPhoneNumberId: string,
): boolean {
  const metadataPhoneId = value.metadata?.phone_number_id;
  const directPhoneId = value.phone_number_id;

  // Every currently documented message/coexistence payload is phone scoped.
  // Requiring both fields avoids accepting an event for a second number that
  // belongs to the same signed Meta app and WABA.
  if (PHONE_SCOPED_FIELDS.has(field)) {
    return (
      value.messaging_product === "whatsapp" &&
      metadataPhoneId === expectedPhoneNumberId &&
      (!directPhoneId || directPhoneId === expectedPhoneNumberId)
    );
  }

  if (metadataPhoneId && metadataPhoneId !== expectedPhoneNumberId) {
    return false;
  }
  if (directPhoneId && directPhoneId !== expectedPhoneNumberId) return false;
  return true;
}

export function metaEventTimestamp(timestamp?: string | number): string {
  const seconds = Number(timestamp);
  return Number.isFinite(seconds) && seconds >= 0
    ? new Date(seconds * 1000).toISOString()
    : new Date().toISOString();
}

export function normalizeWhatsAppPhone(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const digits = String(value).replace(/\D/g, "");
  if (!/^[1-9][0-9]{7,14}$/.test(digits)) return null;
  return `+${digits}`;
}

/**
 * Business-scoped user IDs are opaque Meta identifiers. Keep them byte-for-
 * byte (apart from surrounding whitespace) and reject control characters or
 * oversized values instead of trying to interpret them as phone numbers.
 */
export function normalizeWhatsAppUserId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > 256 ||
    !/^[A-Za-z0-9.]+$/.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

export function metaStatusRecipientUserId(
  value: MetaValue,
  status: MetaStatus,
): string | null {
  const rawStatusUserId =
    typeof status.recipient_user_id === "string" &&
    status.recipient_user_id.trim()
      ? status.recipient_user_id
      : null;
  const statusUserId = normalizeWhatsAppUserId(rawStatusUserId);
  if (rawStatusUserId && !statusUserId) {
    throw new Error("INVALID_STATUS_RECIPIENT_USER_ID");
  }

  const recipientPhone = normalizeWhatsAppPhone(status.recipient_id);
  const matchingContact = value.contacts?.find(
    (contact) =>
      (statusUserId &&
        normalizeWhatsAppUserId(contact.user_id) === statusUserId) ||
      (recipientPhone &&
        normalizeWhatsAppPhone(contact.wa_id) === recipientPhone),
  );
  const soleContact =
    !statusUserId && !recipientPhone && value.contacts?.length === 1
      ? value.contacts[0]
      : undefined;
  const contact = matchingContact ?? soleContact;
  const rawContactUserId =
    typeof contact?.user_id === "string" && contact.user_id.trim()
      ? contact.user_id
      : null;
  const contactUserId = normalizeWhatsAppUserId(rawContactUserId);
  if (rawContactUserId && !contactUserId) {
    throw new Error("INVALID_STATUS_CONTACT_USER_ID");
  }
  if (statusUserId && contactUserId && statusUserId !== contactUserId) {
    throw new Error("WHATSAPP_IDENTITY_CONFLICT");
  }
  return statusUserId ?? contactUserId;
}

export function safeWebhookMetadata(
  entryId: string,
  field: string,
  value: MetaValue,
): Record<string, unknown> {
  const collections = [
    "messages",
    "statuses",
    "history",
    "state_sync",
    "message_echoes",
  ] as const;
  const counts: Record<string, number> = {};
  for (const name of collections) {
    const collection = value[name];
    if (Array.isArray(collection) && collection.length > 0) {
      counts[name] = collection.length;
    }
  }
  return {
    entry_id: entryId,
    field,
    phone_number_id:
      value.metadata?.phone_number_id ?? value.phone_number_id ?? null,
    messaging_product: value.messaging_product ?? null,
    counts,
  };
}
