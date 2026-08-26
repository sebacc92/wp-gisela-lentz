import {
  metaEventTimestamp,
  normalizeWhatsAppPhone,
  normalizeWhatsAppUserId,
  type MetaMessage,
  type MetaValue,
} from "./whatsapp-webhook.ts";

export type StoredMessageType =
  | "text"
  | "template"
  | "interactive"
  | "image"
  | "document"
  | "system";
export type StoredMessageStatus =
  | "pending"
  | "sent"
  | "delivered"
  | "read"
  | "failed";

export interface CoexistenceBatch {
  externalBatchId: string;
  syncType: "history" | "smb_app_state_sync";
  phase: string | null;
  chunkOrder: number | null;
  progress: number | null;
  itemCount: number;
  metadata: Record<string, unknown>;
}

export interface CoexistenceContactOperation {
  kind: "contact";
  action: "add" | "remove";
  phoneE164: string | null;
  whatsappId: string | null;
  whatsappUserId: string | null;
  fullName: string | null;
  sourceTimestamp: string;
  metadata: Record<string, unknown>;
}

export interface CoexistenceBatchOperation {
  kind: "batch";
  batch: CoexistenceBatch;
}

export interface CoexistenceMessageOperation {
  kind: "message";
  source: "history" | "smb_message_echoes" | "messages";
  externalMessageId: string;
  contactPhoneE164: string | null;
  contactWhatsAppId: string | null;
  contactWhatsAppUserId: string | null;
  contactName: string | null;
  direction: "inbound" | "outbound";
  messageType: string;
  storedType: StoredMessageType;
  body: string;
  status: StoredMessageStatus;
  messageAt: string;
  originalMessageId: string | null;
  metadata: Record<string, unknown>;
  batch: CoexistenceBatch | null;
}

export interface CoexistenceHistoryErrorOperation {
  kind: "history_error";
  errorIndex: number;
  code: number | null;
  title: string;
  message: string | null;
  metadata: Record<string, unknown>;
}

export type CoexistenceOperation =
  | CoexistenceBatchOperation
  | CoexistenceContactOperation
  | CoexistenceMessageOperation
  | CoexistenceHistoryErrorOperation;

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function scalarString(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return string(value);
}

function finiteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function strictEventTimestamp(value: unknown, label: string): string {
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    !String(value).trim() ||
    !Number.isFinite(Number(value)) ||
    Number(value) < 0
  ) {
    throw new Error(`INVALID_${label}_TIMESTAMP`);
  }
  return metaEventTimestamp(value);
}

function normalizedDigits(value: unknown): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value).replace(/\D/g, "")
    : "";
}

function strictOptionalUserId(value: unknown, label: string): string | null {
  const raw = string(value);
  if (!raw) return null;
  const normalized = normalizeWhatsAppUserId(raw);
  if (!normalized) throw new Error(`INVALID_${label}_USER_ID`);
  return normalized;
}

function historyStatus(value: unknown): StoredMessageStatus {
  switch (string(value)?.toUpperCase()) {
    case "PENDING":
      return "pending";
    case "SENT":
      return "sent";
    case "DELIVERED":
      return "delivered";
    case "READ":
    case "PLAYED":
      return "read";
    case "ERROR":
      return "failed";
    default:
      throw new Error("INVALID_HISTORY_MESSAGE_STATUS");
  }
}

function contentForMessage(
  message: UnknownRecord,
  rawType: string,
): {
  storedType: StoredMessageType;
  body: string;
  content: unknown;
} {
  const content = message[rawType];
  const detail = record(content);
  if (rawType === "text") {
    return {
      storedType: "text",
      body: string(detail?.body) ?? "",
      content,
    };
  }
  if (rawType === "interactive" || rawType === "button") {
    const buttonReply = record(detail?.button_reply);
    const listReply = record(detail?.list_reply);
    return {
      storedType: "interactive",
      body:
        string(buttonReply?.title) ??
        string(listReply?.title) ??
        string(detail?.text) ??
        string(detail?.payload) ??
        "Respuesta interactiva",
      content,
    };
  }
  if (rawType === "image" || rawType === "document") {
    return {
      storedType: rawType,
      body:
        string(detail?.caption) ??
        string(detail?.filename) ??
        (rawType === "image" ? "Imagen" : "Documento"),
      content,
    };
  }
  if (rawType === "template") {
    return { storedType: "template", body: "Plantilla de WhatsApp", content };
  }
  if (rawType === "reaction") {
    return {
      storedType: "system",
      body: string(detail?.emoji) ?? "Reacción de WhatsApp",
      content,
    };
  }
  if (rawType === "location") {
    const name = string(detail?.name);
    const address = string(detail?.address);
    return {
      storedType: "system",
      body:
        [name, address].filter(Boolean).join(" — ") || "Ubicación compartida",
      content,
    };
  }
  if (rawType === "media_placeholder") {
    return {
      storedType: "system",
      body: "Medio pendiente de sincronización",
      content,
    };
  }
  if (["video", "audio", "sticker"].includes(rawType)) {
    return {
      storedType: "system",
      body: string(detail?.caption) ?? `Archivo de WhatsApp (${rawType})`,
      content,
    };
  }
  return {
    storedType: "system",
    body: `Mensaje de WhatsApp (${rawType || "desconocido"})`,
    content,
  };
}

function mutationDetails(message: UnknownRecord): {
  rawType: string;
  originalMessageId: string | null;
  contentMessage: UnknownRecord;
} {
  const outerType = string(message.type) ?? "unknown";
  if (outerType !== "edit" && outerType !== "revoke") {
    return {
      rawType: outerType,
      originalMessageId: null,
      contentMessage: message,
    };
  }

  const mutation = record(message[outerType]) ?? {};
  if (outerType === "revoke") {
    return {
      rawType: outerType,
      originalMessageId: string(mutation.original_message_id),
      contentMessage: message,
    };
  }
  const editedMessage = record(mutation.message) ?? {};
  return {
    rawType: outerType,
    originalMessageId: string(mutation.original_message_id),
    contentMessage: editedMessage,
  };
}

function normalizeMessageOperation(options: {
  message: UnknownRecord;
  source: CoexistenceMessageOperation["source"];
  displayPhone: string | null;
  fallbackContactPhone: string | null;
  fallbackContactWhatsAppId?: string | null;
  fallbackContactUserId?: string | null;
  fallbackContactName?: string | null;
  fallbackContactUsername?: string | null;
  fallbackContactCountryCode?: string | null;
  forceOutbound?: boolean;
  mediaFollowUp?: boolean;
  batch?: CoexistenceBatch | null;
}): CoexistenceMessageOperation {
  const messageId = string(options.message.id);
  if (!messageId) throw new Error("INVALID_COEXISTENCE_MESSAGE_ID");

  const mutation = mutationDetails(options.message);
  if (
    (mutation.rawType === "edit" || mutation.rawType === "revoke") &&
    !mutation.originalMessageId
  ) {
    throw new Error("INVALID_COEXISTENCE_ORIGINAL_MESSAGE_ID");
  }

  const actualType =
    mutation.rawType === "edit"
      ? (string(mutation.contentMessage.type) ?? "unknown")
      : mutation.rawType;
  const content = contentForMessage(mutation.contentMessage, actualType);
  const contentRecord = record(content.content);
  const fromDigits = normalizedDigits(options.message.from);
  const displayDigits = normalizedDigits(options.displayPhone);
  const toDigits = normalizedDigits(options.message.to);
  const fallbackDigits = normalizedDigits(options.fallbackContactPhone);
  const fromUserId = strictOptionalUserId(
    options.message.from_user_id,
    "COEXISTENCE_FROM",
  );
  const toUserId = strictOptionalUserId(
    options.message.to_user_id,
    "COEXISTENCE_TO",
  );
  const fallbackUserId = strictOptionalUserId(
    options.fallbackContactUserId,
    "COEXISTENCE_CONTACT",
  );

  let inferredDirection: "inbound" | "outbound";
  if (options.forceOutbound) {
    inferredDirection = "outbound";
  } else if (fromDigits && displayDigits && fromDigits === displayDigits) {
    inferredDirection = "outbound";
  } else if (fromUserId) {
    inferredDirection = "inbound";
  } else if (fromDigits) {
    inferredDirection = "inbound";
  } else if (toUserId || toDigits) {
    inferredDirection = "outbound";
  } else if (!options.mediaFollowUp) {
    throw new Error("INVALID_COEXISTENCE_MESSAGE_PARTICIPANTS");
  } else {
    // A media follow-up is joined by wamid only. Its participant fields are
    // intentionally ignored because Meta may omit or contradict them.
    inferredDirection = "inbound";
  }

  if (options.source === "history" && !options.mediaFollowUp) {
    // New coexistence payloads use BSUIDs and can leave every phone-shaped
    // field empty. Legacy payloads use the enclosing thread phone. Validate
    // every participant Meta did provide against that enclosing identity.
    const outbound = inferredDirection === "outbound";
    if (
      (!fallbackDigits && !fallbackUserId) ||
      (fallbackDigits && displayDigits && fallbackDigits === displayDigits) ||
      (outbound && fromDigits && fromDigits !== displayDigits) ||
      (outbound &&
        fromUserId &&
        fallbackUserId &&
        fromUserId !== fallbackUserId) ||
      (outbound && toDigits && fallbackDigits && toDigits !== fallbackDigits) ||
      (outbound && toUserId && fallbackUserId && toUserId !== fallbackUserId) ||
      (!outbound &&
        fromDigits &&
        fallbackDigits &&
        fromDigits !== fallbackDigits) ||
      (!outbound &&
        fromUserId &&
        fallbackUserId &&
        fromUserId !== fallbackUserId) ||
      (!outbound && toDigits && displayDigits && toDigits !== displayDigits) ||
      (!outbound && toUserId && fallbackUserId && toUserId === fallbackUserId)
    ) {
      throw new Error("INVALID_HISTORY_MESSAGE_PARTICIPANTS");
    }
  }
  const direction = inferredDirection;
  const directContactPhone =
    direction === "outbound"
      ? normalizeWhatsAppPhone(options.message.to)
      : normalizeWhatsAppPhone(options.message.from);
  const phoneE164 =
    normalizeWhatsAppPhone(options.fallbackContactPhone) ?? directContactPhone;
  const directContactUserId =
    direction === "outbound" ? (toUserId ?? fromUserId) : fromUserId;
  const whatsappUserId = fallbackUserId ?? directContactUserId;
  if (!options.mediaFollowUp && !phoneE164 && !whatsappUserId) {
    throw new Error("INVALID_COEXISTENCE_MESSAGE_CONTACT");
  }
  const timestamp = strictEventTimestamp(
    options.message.timestamp,
    "COEXISTENCE_MESSAGE",
  );
  const rawHistoryContext = record(options.message.history_context);
  const rawStatus = rawHistoryContext?.status;

  return {
    kind: "message",
    source: options.source,
    externalMessageId: messageId,
    contactPhoneE164: phoneE164,
    contactWhatsAppId:
      string(options.fallbackContactWhatsAppId) ??
      (phoneE164 ? phoneE164.replace(/^\+/, "") : null),
    contactWhatsAppUserId: whatsappUserId,
    contactName: options.fallbackContactName ?? null,
    direction,
    messageType: mutation.rawType,
    storedType: content.storedType,
    body:
      mutation.rawType === "revoke"
        ? "Mensaje eliminado desde WhatsApp"
        : content.body,
    status:
      options.source === "history" && !options.mediaFollowUp
        ? historyStatus(rawStatus)
        : direction === "outbound"
          ? "sent"
          : "delivered",
    messageAt: timestamp,
    originalMessageId: mutation.originalMessageId,
    metadata: {
      source: options.source,
      original_type: mutation.rawType,
      content_type: actualType,
      content: content.content ?? null,
      media_id: string(contentRecord?.id),
      mime_type: string(contentRecord?.mime_type),
      filename: string(contentRecord?.filename),
      sha256: string(contentRecord?.sha256),
      history_status:
        typeof rawStatus === "string" ? rawStatus.toUpperCase() : null,
      media_follow_up: Boolean(options.mediaFollowUp),
      contact_user_id: whatsappUserId,
      contact_username: options.fallbackContactUsername ?? null,
      contact_country_code: options.fallbackContactCountryCode ?? null,
    },
    batch: options.batch ?? null,
  };
}

function historyOperations(value: MetaValue): CoexistenceOperation[] {
  if (
    !Array.isArray(value.history) &&
    !Array.isArray(value.messages) &&
    !Array.isArray(value.message_echoes)
  ) {
    throw new Error("INVALID_HISTORY_COLLECTION");
  }
  const operations: CoexistenceOperation[] = [];
  let historyErrorIndex = 0;
  const displayPhone = string(value.metadata?.display_phone_number);

  for (const rawHistory of array(value.history)) {
    const history = record(rawHistory);
    if (!history) throw new Error("INVALID_HISTORY_BLOCK");
    const errors = array(history.errors);
    const historyMetadata = record(history.metadata) ?? {};
    const phase = scalarString(historyMetadata.phase);
    const chunkOrder = finiteNumber(historyMetadata.chunk_order);
    const progress = finiteNumber(historyMetadata.progress);
    const hasThreadsCollection = Array.isArray(history.threads);
    const rawThreads = array(history.threads);
    const messageCount = rawThreads.reduce<number>((count, rawThread) => {
      const thread = record(rawThread);
      return count + array(thread?.messages).length;
    }, 0);
    const externalBatchId = [
      "history",
      phase ?? "unknown",
      chunkOrder ?? "unknown",
      progress ?? "unknown",
    ].join(":");
    const batch: CoexistenceBatch = {
      externalBatchId,
      syncType: "history",
      phase,
      chunkOrder,
      progress,
      itemCount: messageCount,
      metadata: {},
    };
    if (hasThreadsCollection || Object.keys(historyMetadata).length > 0) {
      operations.push({ kind: "batch", batch });
    }

    for (const rawThread of rawThreads) {
      const thread = record(rawThread);
      if (!thread) throw new Error("INVALID_HISTORY_THREAD");
      const context = record(thread.context) ?? {};
      const contextPhone =
        normalizeWhatsAppPhone(context.wa_id) ??
        normalizeWhatsAppPhone(thread.id);
      const contextWhatsAppId =
        string(context.wa_id) ??
        (contextPhone ? contextPhone.replace(/^\+/, "") : null);
      const contextUserId = strictOptionalUserId(
        context.user_id,
        "HISTORY_CONTEXT",
      );
      const contextName = string(context.username);
      for (const rawMessage of array(thread.messages)) {
        const message = record(rawMessage);
        if (!message) throw new Error("INVALID_HISTORY_MESSAGE");
        operations.push(
          normalizeMessageOperation({
            message,
            source: "history",
            displayPhone,
            fallbackContactPhone: contextPhone,
            fallbackContactWhatsAppId: contextWhatsAppId,
            fallbackContactUserId: contextUserId,
            fallbackContactName: contextName,
            fallbackContactUsername: contextName,
            fallbackContactCountryCode: string(context.country_code),
            batch,
          }),
        );
      }
    }

    // Keep errors last so an error-bearing delivery cannot be accidentally
    // downgraded to partial/completed by a batch update in the same block.
    for (const rawError of errors) {
      const error = record(rawError);
      if (!error) throw new Error("INVALID_HISTORY_ERROR");
      operations.push({
        kind: "history_error",
        errorIndex: historyErrorIndex,
        code: finiteNumber(error.code),
        title: string(error.title) ?? "Error de sincronización de historial",
        message: string(error.message),
        metadata: {
          href: string(error.href),
          error_data: record(error.error_data),
        },
      });
      historyErrorIndex += 1;
    }
  }

  // Media assets are delivered later with the same wamid: inbound assets under
  // `messages`, outbound assets under `message_echoes`. Both are wamid-only
  // enrichment and must never reassign message ownership or direction.
  for (const rawMessage of [
    ...array(value.messages),
    ...array(value.message_echoes),
  ]) {
    const message = record(rawMessage);
    if (!message) throw new Error("INVALID_HISTORY_MEDIA_MESSAGE");
    operations.push(
      normalizeMessageOperation({
        message,
        source: "history",
        displayPhone,
        fallbackContactPhone: null,
        mediaFollowUp: true,
      }),
    );
  }

  return operations;
}

function stateSyncOperations(value: MetaValue): CoexistenceOperation[] {
  if (!Array.isArray(value.state_sync)) {
    throw new Error("INVALID_STATE_SYNC_COLLECTION");
  }
  return array(value.state_sync).map((rawItem) => {
    const item = record(rawItem);
    const contact = record(item?.contact);
    const metadata = record(item?.metadata);
    const action = string(item?.action);
    const phone = normalizeWhatsAppPhone(contact?.phone_number);
    const userId = strictOptionalUserId(contact?.user_id, "STATE_SYNC_CONTACT");
    if (
      !item ||
      string(item.type) !== "contact" ||
      (action !== "add" && action !== "remove") ||
      (!phone && !userId)
    ) {
      throw new Error("INVALID_STATE_SYNC_CONTACT");
    }
    const operation: CoexistenceContactOperation = {
      kind: "contact",
      action,
      phoneE164: phone,
      whatsappId: phone ? phone.replace(/^\+/, "") : null,
      whatsappUserId: userId,
      fullName:
        string(contact?.full_name) ??
        string(contact?.first_name) ??
        string(contact?.username) ??
        null,
      sourceTimestamp: strictEventTimestamp(metadata?.timestamp, "STATE_SYNC"),
      metadata: {
        source: "smb_app_state_sync",
        first_name: string(contact?.first_name),
        username: string(contact?.username),
        country_code: string(contact?.country_code),
      },
    };
    return operation;
  });
}

function echoOperations(value: MetaValue): CoexistenceOperation[] {
  if (!Array.isArray(value.message_echoes)) {
    throw new Error("INVALID_MESSAGE_ECHO_COLLECTION");
  }
  const displayPhone = string(value.metadata?.display_phone_number);
  return array(value.message_echoes).map((rawMessage) => {
    const message = record(rawMessage);
    if (!message) throw new Error("INVALID_MESSAGE_ECHO");
    const rawToUserId = strictOptionalUserId(
      message.to_user_id,
      "MESSAGE_ECHO_TO",
    );
    const toPhone = normalizeWhatsAppPhone(message.to);
    const matchingContact = (value.contacts ?? []).find((contact) => {
      const userId = normalizeWhatsAppUserId(contact.user_id);
      const phone = normalizeWhatsAppPhone(contact.wa_id);
      return (
        (rawToUserId && userId === rawToUserId) ||
        (toPhone && phone === toPhone)
      );
    });
    const soleContact = value.contacts?.length === 1 ? value.contacts[0] : null;
    const contact = matchingContact ?? soleContact;
    const contactUserId =
      strictOptionalUserId(contact?.user_id, "MESSAGE_ECHO_CONTACT") ??
      rawToUserId;
    const contactPhone = normalizeWhatsAppPhone(contact?.wa_id) ?? toPhone;
    if (!contactPhone && !contactUserId) {
      throw new Error("INVALID_MESSAGE_ECHO_RECIPIENT");
    }
    if (
      (rawToUserId && contactUserId && rawToUserId !== contactUserId) ||
      (toPhone && contactPhone && toPhone !== contactPhone)
    ) {
      throw new Error("INVALID_MESSAGE_ECHO_RECIPIENT");
    }
    const fromPhone = normalizeWhatsAppPhone(message.from);
    if (
      fromPhone &&
      (!displayPhone || fromPhone !== normalizeWhatsAppPhone(displayPhone))
    ) {
      throw new Error("INVALID_MESSAGE_ECHO_SENDER");
    }
    const operation = normalizeMessageOperation({
      message,
      source: "smb_message_echoes",
      displayPhone,
      fallbackContactPhone: contactPhone,
      fallbackContactWhatsAppId: string(contact?.wa_id),
      fallbackContactUserId: contactUserId,
      fallbackContactName:
        string(contact?.profile?.name) ?? string(contact?.profile?.username),
      fallbackContactUsername: string(contact?.profile?.username),
      fallbackContactCountryCode: string(contact?.profile?.country_code),
      forceOutbound: true,
    });
    return operation;
  });
}

export function appEchoContactIdentities(
  value: MetaValue,
): Array<{ phoneE164: string | null; whatsappUserId: string | null }> {
  const identities = new Map<
    string,
    { phoneE164: string | null; whatsappUserId: string | null }
  >();
  for (const operation of echoOperations(value)) {
    if (operation.kind !== "message") continue;
    const identity = {
      phoneE164: operation.contactPhoneE164,
      whatsappUserId: operation.contactWhatsAppUserId,
    };
    identities.set(
      `${identity.whatsappUserId ?? ""}\u0000${identity.phoneE164 ?? ""}`,
      identity,
    );
  }
  return [...identities.values()];
}

function liveMutationOperations(value: MetaValue): CoexistenceOperation[] {
  const displayPhone = string(value.metadata?.display_phone_number);
  return array(value.messages).map((rawMessage) => {
    const message = record(rawMessage);
    if (!message) throw new Error("INVALID_LIVE_MESSAGE_MUTATION");
    const rawType = string(message.type);
    if (rawType !== "edit" && rawType !== "revoke") {
      throw new Error("INVALID_LIVE_MESSAGE_MUTATION_TYPE");
    }
    const messageUserId = strictOptionalUserId(
      message.from_user_id,
      "LIVE_MESSAGE",
    );
    const messagePhone = normalizeWhatsAppPhone(message.from);
    const contact = (value.contacts ?? []).find(
      (candidate) =>
        (messageUserId &&
          normalizeWhatsAppUserId(candidate.user_id) === messageUserId) ||
        (messagePhone &&
          normalizeWhatsAppPhone(candidate.wa_id) === messagePhone),
    );
    return normalizeMessageOperation({
      message,
      source: "messages",
      displayPhone,
      fallbackContactPhone:
        normalizeWhatsAppPhone(contact?.wa_id) ?? messagePhone,
      fallbackContactWhatsAppId: string(contact?.wa_id),
      fallbackContactUserId:
        strictOptionalUserId(contact?.user_id, "LIVE_CONTACT") ?? messageUserId,
      fallbackContactName:
        string(contact?.profile?.name) ?? string(contact?.profile?.username),
      fallbackContactUsername: string(contact?.profile?.username),
      fallbackContactCountryCode: string(contact?.profile?.country_code),
    });
  });
}

export function coexistenceOperations(
  field: string,
  value: MetaValue,
): CoexistenceOperation[] {
  if (field === "history") return historyOperations(value);
  if (field === "smb_app_state_sync") return stateSyncOperations(value);
  if (field === "smb_message_echoes") return echoOperations(value);
  if (field === "messages") return liveMutationOperations(value);
  throw new Error("UNSUPPORTED_COEXISTENCE_FIELD");
}

export function liveMessageMutations(value: MetaValue): MetaMessage[] {
  return (value.messages ?? []).filter(
    (message) => message.type === "edit" || message.type === "revoke",
  );
}
