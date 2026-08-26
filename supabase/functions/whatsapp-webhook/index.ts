import { jsonResponse, safeErrorMessage } from "../_shared/http.ts";
import { processIncomingMessage } from "../_shared/incoming-message.ts";
import { createServiceClient, getServiceKey } from "../_shared/supabase.ts";
import { whatsappAutomationsEnabled } from "../_shared/whatsapp.ts";
import { finalizeIncomingWebhookMessage } from "../_shared/whatsapp-automation-outbox.ts";
import {
  appEchoContactIdentities,
  liveMessageMutations,
} from "../_shared/whatsapp-coexistence.ts";
import {
  constantTimeEqual,
  configuredWebhookBodyLimit,
  decodeWhatsAppWebhookBody,
  isExpectedWhatsAppBusinessAccount,
  isTrustedWhatsAppChange,
  metaChangeEventId,
  metaEventTimestamp,
  metaStatusRecipientUserId,
  normalizeWhatsAppPhone,
  normalizeWhatsAppUserId,
  readWhatsAppWebhookBody,
  routeWhatsAppChange,
  safeWebhookMetadata,
  verifyMetaSignature,
  WhatsAppWebhookPayloadTooLargeError,
  type MetaMessage,
  type MetaStatus,
  type MetaValue,
  type MetaWebhook,
} from "../_shared/whatsapp-webhook.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.112.2";

function messageContent(message: MetaMessage): {
  type: "text" | "interactive" | "image" | "document";
  body: string;
  metadata: Record<string, unknown>;
} {
  if (message.type === "interactive" && message.interactive) {
    const reply =
      message.interactive.button_reply ?? message.interactive.list_reply;
    return {
      type: "interactive",
      body: reply?.title ?? "Respuesta interactiva",
      metadata: {
        interactive_reply_id: reply?.id ?? null,
        interactive_type: message.interactive.type ?? null,
      },
    };
  }
  if (message.type === "button" && message.button) {
    return {
      type: "interactive",
      body: message.button.text ?? message.button.payload ?? "Respuesta",
      metadata: { interactive_reply_id: message.button.payload ?? null },
    };
  }
  if (message.type === "image" && message.image) {
    return {
      type: "image",
      body: message.image.caption ?? "Imagen",
      metadata: {
        media_id: message.image.id ?? null,
        mime_type: message.image.mime_type ?? null,
      },
    };
  }
  if (message.type === "document" && message.document) {
    return {
      type: "document",
      body:
        message.document.caption ?? message.document.filename ?? "Documento",
      metadata: {
        media_id: message.document.id ?? null,
        mime_type: message.document.mime_type ?? null,
        filename: message.document.filename ?? null,
      },
    };
  }
  return {
    type: "text",
    body: message.text?.body ?? "Mensaje no compatible",
    metadata: { original_type: message.type ?? "unknown" },
  };
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`CONFIGURATION_INCOMPLETE:${name}`);
  return value;
}

async function claimWebhookEvent(
  client: SupabaseClient,
  externalEventId: string,
  eventType: string,
  metadata: Record<string, unknown>,
): Promise<"claimed" | "duplicate" | "busy"> {
  const { data, error } = await client.rpc("claim_whatsapp_webhook_event", {
    p_external_event_id: externalEventId,
    p_event_type: eventType,
    p_metadata: metadata,
    p_stale_after_seconds: 900,
  });
  if (error) throw new Error(`WEBHOOK_CLAIM_FAILED:${error.message}`);
  if (data === true) return "claimed";

  const existing = await client
    .from("webhook_events")
    .select("status")
    .eq("external_event_id", externalEventId)
    .maybeSingle();
  if (existing.error) {
    throw new Error(`WEBHOOK_CLAIM_LOOKUP_FAILED:${existing.error.message}`);
  }
  return existing.data?.status === "processed" ||
    existing.data?.status === "ignored"
    ? "duplicate"
    : "busy";
}

async function finishWebhookEvent(
  client: SupabaseClient,
  externalEventId: string,
): Promise<void> {
  const { data, error } = await client.rpc("complete_whatsapp_webhook_event", {
    p_external_event_id: externalEventId,
    p_status: "processed",
    p_error: null,
  });
  if (error || data !== true) {
    throw new Error(
      `WEBHOOK_COMPLETION_FAILED:${error?.message ?? "NO_CLAIM"}`,
    );
  }
}

async function failWebhookEvent(
  client: SupabaseClient,
  externalEventId: string,
  error: unknown,
): Promise<void> {
  const { error: completionError } = await client.rpc(
    "complete_whatsapp_webhook_event",
    {
      p_external_event_id: externalEventId,
      p_status: "failed",
      p_error: safeErrorMessage(error),
    },
  );
  if (completionError) {
    console.error("Webhook failure could not be recorded", {
      code: completionError.message,
      eventId: externalEventId,
    });
  }
}

async function recordIgnoredWebhookEvent(
  client: SupabaseClient,
  externalEventId: string,
  eventType: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  const { error } = await client.from("webhook_events").insert({
    external_event_id: externalEventId,
    event_type: eventType,
    status: "ignored",
    metadata,
    processed_at: new Date().toISOString(),
  });
  if (error && error.code !== "23505") throw error;
}

async function recordQueuedWebhookEvent(
  client: SupabaseClient,
  externalEventId: string,
  eventType: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  const { error } = await client.from("webhook_events").insert({
    external_event_id: externalEventId,
    event_type: eventType,
    status: "processed",
    metadata,
    processed_at: new Date().toISOString(),
  });
  if (error && error.code !== "23505") throw error;
}

async function ensureCoexistenceAccount(
  client: SupabaseClient,
  wabaId: string,
  phoneNumberId: string,
  displayPhone: string | undefined,
): Promise<string> {
  const { data, error } = await client.rpc(
    "upsert_whatsapp_coexistence_account",
    {
      p_waba_id: wabaId,
      p_phone_number_id: phoneNumberId,
      p_display_phone: displayPhone ?? null,
      p_coexistence_status: "active",
      p_metadata: { observed_from: "signed_webhook" },
    },
  );
  const row = (Array.isArray(data) ? data[0] : data) as { id?: string } | null;
  if (error || !row?.id) {
    throw new Error(`COEXISTENCE_ACCOUNT_FAILED:${error?.message ?? "NO_ROW"}`);
  }
  return row.id;
}

async function enqueueCoexistenceChange(
  client: SupabaseClient,
  accountId: string,
  externalEventId: string,
  field: string,
  value: MetaValue,
  metadata: Record<string, unknown>,
): Promise<void> {
  const { error } = await client.rpc("enqueue_whatsapp_coexistence_event", {
    p_account_id: accountId,
    p_external_event_id: externalEventId,
    p_field: field,
    p_payload: value,
    p_metadata: metadata,
  });
  if (error) throw new Error(`COEXISTENCE_ENQUEUE_FAILED:${error.message}`);
}

async function pauseAutomationForAppEchoes(
  client: SupabaseClient,
  payload: MetaWebhook,
  expectedWabaId: string,
  expectedPhoneNumberId: string,
): Promise<void> {
  const seen = new Set<string>();
  for (const entry of payload.entry ?? []) {
    if (!isExpectedWhatsAppBusinessAccount(entry.id, expectedWabaId)) continue;
    for (const change of entry.changes ?? []) {
      if (
        change.field !== "smb_message_echoes" ||
        !change.value ||
        !isTrustedWhatsAppChange(
          change.field,
          change.value,
          expectedPhoneNumberId,
        )
      ) {
        continue;
      }
      for (const identity of appEchoContactIdentities(change.value)) {
        const key = `${identity.whatsappUserId ?? ""}\u0000${identity.phoneE164 ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const { error } = await client.rpc(
          "pause_whatsapp_automation_for_app_echo",
          {
            p_phone_e164: identity.phoneE164,
            p_whatsapp_user_id: identity.whatsappUserId,
          },
        );
        if (error) {
          throw new Error(`APP_ECHO_PAUSE_FAILED:${error.message}`);
        }
      }
    }
  }
}

function normalizedEvent(value: MetaValue): string {
  return (value.event ?? value.status ?? value.decision ?? "UNKNOWN")
    .trim()
    .toUpperCase();
}

async function pauseSending(
  client: SupabaseClient,
  reason: string,
  additional: Record<string, unknown> = {},
): Promise<void> {
  const { error } = await client
    .from("whatsapp_settings")
    .update({
      ...additional,
      sending_paused: true,
      sending_pause_reason: reason,
      integration_status: "error",
      last_error: reason,
      updated_at: new Date().toISOString(),
    })
    .eq("id", true)
    .select("id")
    .single();
  if (error) throw error;
}

async function processQualityUpdate(
  client: SupabaseClient,
  value: MetaValue,
): Promise<void> {
  const event = normalizedEvent(value);
  const rawRating = value.quality_rating?.trim().toUpperCase();
  const qualityRating =
    rawRating && ["GREEN", "YELLOW", "RED"].includes(rawRating)
      ? rawRating
      : undefined;
  const updatedAt = new Date().toISOString();
  const qualityFields: Record<string, unknown> = {
    quality_updated_at: updatedAt,
    updated_at: updatedAt,
  };
  if (qualityRating) qualityFields.quality_rating = qualityRating;

  if (event === "FLAGGED" || qualityRating === "RED") {
    await pauseSending(
      client,
      event === "FLAGGED" ? "META_PHONE_NUMBER_FLAGGED" : "META_QUALITY_RED",
      qualityFields,
    );
    return;
  }

  // A healthy event is recorded, but never clears a manual/automatic pause.
  const { error } = await client
    .from("whatsapp_settings")
    .update(qualityFields)
    .eq("id", true)
    .select("id")
    .single();
  if (error) throw error;
}

async function processAccountUpdate(
  client: SupabaseClient,
  value: MetaValue,
): Promise<void> {
  const event = (
    value.ban_info?.waba_ban_state ?? normalizedEvent(value)
  ).toUpperCase();
  if (
    /(DISABL|BLOCK|BAN|SUSPEND|RESTRICT|VIOLATION|FLAGGED|DELET|REJECT)/.test(
      event,
    )
  ) {
    await pauseSending(client, `META_ACCOUNT_${event.slice(0, 80)}`);
  }
}

async function processTemplateStatusUpdate(
  client: SupabaseClient,
  value: MetaValue,
): Promise<void> {
  const event = normalizedEvent(value);
  const metaStatus =
    event === "DELETED"
      ? "DISABLED"
      : event === "FLAGGED"
        ? "PAUSED"
        : ["APPROVED", "REJECTED", "PAUSED", "DISABLED"].includes(event)
          ? event
          : "PENDING";
  const templateName = value.message_template_name?.trim();
  const language = value.message_template_language?.trim();
  const templateId =
    value.message_template_id === undefined
      ? undefined
      : String(value.message_template_id);

  if (templateName) {
    const updates: Record<string, unknown> = {
      meta_status: metaStatus,
      last_synced_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    if (templateId) updates.meta_template_id = templateId;

    let query = client
      .from("message_templates")
      .update(updates)
      .eq("meta_name", templateName);
    if (language) query = query.eq("language_code", language);
    const { error } = await query;
    if (error) throw error;
  }

  if (["REJECTED", "DISABLED", "PAUSED"].includes(metaStatus)) {
    await pauseSending(
      client,
      `META_TEMPLATE_${metaStatus}:${(templateName ?? "unknown").slice(0, 100)}`,
    );
  }
}

async function processTemplateQualityUpdate(
  client: SupabaseClient,
  value: MetaValue,
): Promise<void> {
  const templateName = value.message_template_name?.trim();
  const templateId =
    value.message_template_id === undefined
      ? undefined
      : String(value.message_template_id);
  const rawQuality = (
    value.quality_rating ??
    value.quality_score ??
    value.event
  )
    ?.trim()
    .toUpperCase();
  const rating =
    rawQuality && ["GREEN", "YELLOW", "RED"].includes(rawQuality)
      ? rawQuality
      : "UNKNOWN";
  const updates: Record<string, unknown> = {
    quality_rating: rating,
    last_synced_at: new Date().toISOString(),
  };
  if (rating === "RED") updates.enabled = false;

  let query = client.from("message_templates").update(updates);
  if (templateId) query = query.eq("meta_template_id", templateId);
  else if (templateName) query = query.eq("meta_name", templateName);
  else return;
  const { error } = await query;
  if (error) throw error;

  if (rating === "RED") {
    await pauseSending(
      client,
      `META_TEMPLATE_QUALITY_RED:${(templateName ?? templateId ?? "unknown").slice(0, 100)}`,
    );
  }
}

async function applyMessageStatus(
  client: SupabaseClient,
  status: MetaStatus,
  recipientUserId: string | null,
): Promise<void> {
  const statusAt = metaEventTimestamp(status.timestamp);
  const metadata: Record<string, unknown> = {
    delivery_status_at: statusAt,
    delivery_recipient_id: status.recipient_id ?? null,
    delivery_recipient_user_id: recipientUserId,
  };
  if (status.errors?.length) {
    metadata.delivery_errors = status.errors.map((error) => ({
      code: error.code ?? null,
      title: error.title ?? error.message ?? "Delivery failed",
    }));
  }

  const mappedStatus = status.status === "played" ? "read" : status.status;
  metadata.delivery_status_raw = status.status;
  const { data, error } = await client.rpc("apply_whatsapp_message_status", {
    p_whatsapp_message_id: status.id,
    p_status: mappedStatus,
    p_status_at: statusAt,
    p_recipient_user_id: recipientUserId,
    p_metadata: metadata,
  });
  if (error) throw new Error(`MESSAGE_STATUS_FAILED:${error.message}`);
  if (data !== true) throw new Error("MESSAGE_STATUS_TARGET_MISSING");
}

async function scheduleAutomationOutboxProcessor(): Promise<void> {
  const internalSecret = Deno.env.get("AUTOMATION_INTERNAL_SECRET")?.trim();
  const url = Deno.env.get("SUPABASE_URL")?.trim();
  if (!internalSecret || !url) {
    console.warn("Automation queued but outbox processor was not invoked", {
      code: "AUTOMATION_CONFIGURATION_INCOMPLETE",
    });
    return;
  }

  const task = fetch(`${url}/functions/v1/process-whatsapp-automation-outbox`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getServiceKey()}`,
      "Content-Type": "application/json",
      "x-internal-secret": internalSecret,
    },
    body: "{}",
  }).then((response) => {
    if (!response.ok) {
      console.error("Automation outbox processor invocation failed", {
        status: response.status,
      });
    }
  });
  const runtime = (
    globalThis as typeof globalThis & {
      EdgeRuntime?: { waitUntil(promise: Promise<unknown>): void };
    }
  ).EdgeRuntime;
  if (runtime?.waitUntil) runtime.waitUntil(task);
  else await task;
}

async function triggerCoexistenceProcessor(): Promise<void> {
  const internalSecret = Deno.env
    .get("WHATSAPP_COEXISTENCE_INTERNAL_SECRET")
    ?.trim();
  const url = Deno.env.get("SUPABASE_URL")?.trim();
  if (!internalSecret || !url) {
    console.warn("Coexistence event queued but processor was not invoked", {
      code: "COEXISTENCE_PROCESSOR_CONFIGURATION_MISSING",
    });
    return;
  }

  const response = await fetch(
    `${url}/functions/v1/process-whatsapp-coexistence`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${getServiceKey()}`,
        "Content-Type": "application/json",
        "x-internal-secret": internalSecret,
      },
      body: "{}",
    },
  );
  if (!response.ok) {
    console.error("Coexistence processor invocation failed", {
      status: response.status,
    });
  }
}

async function scheduleCoexistenceProcessor(): Promise<void> {
  const task = triggerCoexistenceProcessor().catch((error) => {
    console.error("Coexistence processor invocation failed", {
      code: safeErrorMessage(error),
    });
  });
  const runtime = (
    globalThis as typeof globalThis & {
      EdgeRuntime?: { waitUntil(promise: Promise<unknown>): void };
    }
  ).EdgeRuntime;
  if (runtime?.waitUntil) {
    runtime.waitUntil(task);
    return;
  }
  await task;
}

Deno.serve(async (request) => {
  const url = new URL(request.url);

  if (request.method === "GET") {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");
    const expectedToken = Deno.env.get("META_WEBHOOK_VERIFY_TOKEN")?.trim();
    if (
      mode === "subscribe" &&
      token !== null &&
      expectedToken &&
      challenge !== null &&
      constantTimeEqual(token, expectedToken)
    ) {
      return new Response(challenge, {
        status: 200,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }
    return new Response("Forbidden", { status: 403 });
  }

  if (request.method !== "POST") {
    return jsonResponse(request, { error: "METHOD_NOT_ALLOWED" }, 405);
  }

  let rawBody: Uint8Array;
  try {
    rawBody = await readWhatsAppWebhookBody(
      request,
      configuredWebhookBodyLimit(Deno.env.get("WHATSAPP_WEBHOOK_MAX_BYTES")),
    );
  } catch (error) {
    if (error instanceof WhatsAppWebhookPayloadTooLargeError) {
      return jsonResponse(request, { error: "PAYLOAD_TOO_LARGE" }, 413);
    }
    return jsonResponse(request, { error: "INVALID_BODY" }, 400);
  }
  const signature = request.headers.get("x-hub-signature-256") ?? "";
  const appSecret = Deno.env.get("META_APP_SECRET")?.trim() ?? "";
  if (!(await verifyMetaSignature(rawBody, signature, appSecret))) {
    return jsonResponse(request, { error: "INVALID_SIGNATURE" }, 401);
  }

  let payload: MetaWebhook;
  try {
    payload = JSON.parse(decodeWhatsAppWebhookBody(rawBody)) as MetaWebhook;
  } catch {
    return jsonResponse(request, { error: "INVALID_JSON" }, 400);
  }

  if (payload.object !== "whatsapp_business_account") {
    return jsonResponse(request, { received: true, ignored: true });
  }

  let expectedWabaId: string;
  let expectedPhoneNumberId: string;
  try {
    expectedWabaId = requiredEnv("WHATSAPP_BUSINESS_ACCOUNT_ID");
    expectedPhoneNumberId = requiredEnv("WHATSAPP_PHONE_NUMBER_ID");
  } catch (error) {
    console.error("whatsapp-webhook", safeErrorMessage(error));
    return jsonResponse(request, { error: "CONFIGURATION_INCOMPLETE" }, 500);
  }

  const client = createServiceClient();
  const automationsEnabled = whatsappAutomationsEnabled();
  let queuedAutomationDispatches = 0;
  let coexistenceAccountId: string | null = null;
  let queuedCoexistenceEvents = 0;
  let ignoredEntries = 0;
  let ignoredChanges = 0;

  try {
    // An app-originated echo is the durable signal that a human took control.
    // Apply that pause for every trusted change before any live inbound change
    // in this delivery can release an automation dispatch.
    await pauseAutomationForAppEchoes(
      client,
      payload,
      expectedWabaId,
      expectedPhoneNumberId,
    );

    for (const entry of payload.entry ?? []) {
      // The signature proves the request came from the configured Meta app. The
      // WABA and phone checks additionally prevent a valid multi-account app
      // event from mutating this tenant.
      const entryId = entry.id;
      if (!isExpectedWhatsAppBusinessAccount(entryId, expectedWabaId)) {
        ignoredEntries += 1;
        continue;
      }

      for (const change of entry.changes ?? []) {
        if (!change.field || !change.value) continue;
        const value = change.value;
        if (
          !isTrustedWhatsAppChange(change.field, value, expectedPhoneNumberId)
        ) {
          ignoredChanges += 1;
          continue;
        }

        const route = routeWhatsAppChange(change.field);
        if (route === "coexistence") {
          const eventId = await metaChangeEventId(entryId, change.field, value);
          coexistenceAccountId ??= await ensureCoexistenceAccount(
            client,
            entryId,
            expectedPhoneNumberId,
            value.metadata?.display_phone_number,
          );
          const metadata = safeWebhookMetadata(entryId, change.field, value);
          await enqueueCoexistenceChange(
            client,
            coexistenceAccountId,
            eventId,
            change.field,
            value,
            metadata,
          );
          await recordQueuedWebhookEvent(
            client,
            eventId,
            `queued.${change.field}`,
            metadata,
          );
          queuedCoexistenceEvents += 1;
          continue;
        }

        if (route === "unknown") {
          const eventId = await metaChangeEventId(entryId, change.field, value);
          await recordIgnoredWebhookEvent(
            client,
            eventId,
            `ignored.${change.field.slice(0, 120)}`,
            safeWebhookMetadata(entryId, change.field, value),
          );
          ignoredChanges += 1;
          continue;
        }

        if (route === "operational") {
          const eventId = await metaChangeEventId(entryId, change.field, value);
          const claimed = await claimWebhookEvent(
            client,
            eventId,
            change.field,
            {
              entry_id: entryId,
              event: normalizedEvent(value),
              template_id: value.message_template_id ?? null,
              template_name: value.message_template_name ?? null,
            },
          );
          if (claimed === "duplicate") continue;
          if (claimed === "busy") throw new Error("WEBHOOK_EVENT_IN_PROGRESS");

          try {
            if (change.field === "phone_number_quality_update") {
              await processQualityUpdate(client, value);
            } else if (
              change.field === "account_update" ||
              change.field === "account_review_update" ||
              change.field === "business_capability_update"
            ) {
              await processAccountUpdate(client, value);
            } else if (change.field === "message_template_quality_update") {
              await processTemplateQualityUpdate(client, value);
            } else {
              await processTemplateStatusUpdate(client, value);
            }
            await finishWebhookEvent(client, eventId);
          } catch (error) {
            await failWebhookEvent(client, eventId, error);
            throw error;
          }
          continue;
        }

        const mutations = liveMessageMutations(value);
        if (mutations.length) {
          const mutationValue: MetaValue = {
            ...value,
            messages: mutations,
            statuses: undefined,
          };
          const eventId = await metaChangeEventId(
            entryId,
            "messages",
            mutationValue,
          );
          coexistenceAccountId ??= await ensureCoexistenceAccount(
            client,
            entryId,
            expectedPhoneNumberId,
            value.metadata?.display_phone_number,
          );
          const metadata = safeWebhookMetadata(
            entryId,
            "messages",
            mutationValue,
          );
          await enqueueCoexistenceChange(
            client,
            coexistenceAccountId,
            eventId,
            "messages",
            mutationValue,
            metadata,
          );
          await recordQueuedWebhookEvent(
            client,
            eventId,
            "queued.messages.mutation",
            metadata,
          );
          queuedCoexistenceEvents += 1;
        }

        for (const message of value.messages ?? []) {
          if (message.type === "edit" || message.type === "revoke") continue;
          const claimed = await claimWebhookEvent(
            client,
            message.id,
            `message.${message.type ?? "unknown"}`,
            { entry_id: entryId },
          );
          if (claimed === "duplicate") continue;
          if (claimed === "busy") throw new Error("WEBHOOK_EVENT_IN_PROGRESS");

          try {
            const rawMessageUserId =
              typeof message.from_user_id === "string" &&
              message.from_user_id.trim()
                ? message.from_user_id
                : null;
            const messageUserId = normalizeWhatsAppUserId(rawMessageUserId);
            if (rawMessageUserId && !messageUserId) {
              throw new Error("INVALID_MESSAGE_SENDER_USER_ID");
            }
            const messagePhone = normalizeWhatsAppPhone(message.from);
            const matchingContact = value.contacts?.find(
              (contact) =>
                (messageUserId &&
                  normalizeWhatsAppUserId(contact.user_id) === messageUserId) ||
                (messagePhone &&
                  normalizeWhatsAppPhone(contact.wa_id) === messagePhone),
            );
            const contact =
              matchingContact ??
              (value.contacts?.length === 1 ? value.contacts[0] : undefined);
            const rawContactUserId =
              typeof contact?.user_id === "string" && contact.user_id.trim()
                ? contact.user_id
                : null;
            const normalizedContactUserId =
              normalizeWhatsAppUserId(rawContactUserId);
            if (rawContactUserId && !normalizedContactUserId) {
              throw new Error("INVALID_MESSAGE_CONTACT_USER_ID");
            }
            const contactUserId = normalizedContactUserId ?? messageUserId;
            const contactPhone =
              normalizeWhatsAppPhone(contact?.wa_id) ?? messagePhone;
            if (
              (messageUserId &&
                contactUserId &&
                messageUserId !== contactUserId) ||
              (messagePhone && contactPhone && messagePhone !== contactPhone)
            ) {
              throw new Error("WHATSAPP_IDENTITY_CONFLICT");
            }
            if (!contactPhone && !contactUserId) {
              throw new Error("INVALID_MESSAGE_SENDER");
            }
            const rawProfileName =
              contact?.profile?.name ??
              contact?.profile?.username ??
              "Paciente";
            const profileName =
              rawProfileName.trim().slice(0, 120) || "Paciente";
            const content = messageContent(message);
            const processed = await processIncomingMessage({
              client,
              automationsEnabled,
              resumeSideEffectsOnDuplicate: true,
              reserveAutomationDispatch: true,
              message: {
                externalMessageId: message.id,
                phoneE164: contactPhone,
                whatsappId:
                  typeof contact?.wa_id === "string" && contact.wa_id.trim()
                    ? contact.wa_id.trim()
                    : typeof message.from === "string" && message.from.trim()
                      ? message.from.trim()
                      : null,
                whatsappUserId: contactUserId,
                profileName,
                type: content.type,
                body: content.body,
                metadata: {
                  ...content.metadata,
                  whatsapp_user_id: contactUserId,
                  username: contact?.profile?.username ?? null,
                  country_code: contact?.profile?.country_code ?? null,
                },
                receivedAt: metaEventTimestamp(message.timestamp),
              },
            });

            const queuedAutomation = await finalizeIncomingWebhookMessage({
              client,
              externalEventId: message.id,
              messageId: processed.messageId,
              shouldRunAutomation: processed.shouldRunAutomation,
            });
            if (queuedAutomation) {
              queuedAutomationDispatches += 1;
            }
          } catch (error) {
            await failWebhookEvent(client, message.id, error);
            throw error;
          }
        }

        for (const status of value.statuses ?? []) {
          const eventId = `${status.id}:${status.status}:${status.timestamp ?? ""}`;
          const claimed = await claimWebhookEvent(
            client,
            eventId,
            `status.${status.status}`,
            { entry_id: entryId },
          );
          if (claimed === "duplicate") continue;
          if (claimed === "busy") throw new Error("WEBHOOK_EVENT_IN_PROGRESS");

          try {
            await applyMessageStatus(
              client,
              status,
              metaStatusRecipientUserId(value, status),
            );
            await finishWebhookEvent(client, eventId);
          } catch (error) {
            await failWebhookEvent(client, eventId, error);
            throw error;
          }
        }
      }
    }

    if (queuedAutomationDispatches) {
      await scheduleAutomationOutboxProcessor();
    }
    if (queuedCoexistenceEvents) await scheduleCoexistenceProcessor();
    return jsonResponse(request, {
      received: true,
      ...(queuedCoexistenceEvents ? { queuedCoexistenceEvents } : {}),
      ...(queuedAutomationDispatches ? { queuedAutomationDispatches } : {}),
      ...(ignoredEntries ? { ignoredEntries } : {}),
      ...(ignoredChanges ? { ignoredChanges } : {}),
    });
  } catch (error) {
    console.error("whatsapp-webhook", safeErrorMessage(error));
    return jsonResponse(request, { error: "PROCESSING_FAILED" }, 500);
  }
});
