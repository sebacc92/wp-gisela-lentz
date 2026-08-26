import assert from "node:assert/strict";
import test from "node:test";

import {
  appEchoContactIdentities,
  coexistenceOperations,
  liveMessageMutations,
} from "./whatsapp-coexistence.ts";
import {
  baseValue,
  historyDeclinedFixture,
  historyFixture,
  historyMediaFollowUpFixture,
  historyOutboundMediaFollowUpFixture,
  liveMutationFixture,
  messageEchoesFixture,
  messagesFixture,
  stateSyncFixture,
  TEST_CONTACT_PHONE,
  TEST_CONTACT_USER_ID,
  TEST_PHONE_NUMBER_ID,
  TEST_WABA_ID,
  unknownFieldFixture,
} from "./whatsapp-webhook-fixtures.ts";
import {
  configuredWebhookBodyLimit,
  decodeWhatsAppWebhookBody,
  DEFAULT_WHATSAPP_WEBHOOK_MAX_BYTES,
  hexadecimal,
  isExpectedWhatsAppBusinessAccount,
  isIgnorableCoexistenceSyncRejection,
  isTrustedWhatsAppChange,
  metaAccountUpdateIdentity,
  metaChangePhoneNumberId,
  metaChangeEventId,
  metaWebhookEntryTimestamp,
  metaStatusRecipientUserId,
  normalizeWhatsAppUserId,
  readWhatsAppWebhookBody,
  routeWhatsAppChange,
  safeWebhookMetadata,
  verifyMetaSignature,
  whatsappChangeIdentityScope,
  WhatsAppWebhookPayloadTooLargeError,
  type MetaValue,
  type MetaWebhook,
} from "./whatsapp-webhook.ts";

function onlyChange(payload: MetaWebhook): { field: string; value: MetaValue } {
  const change = payload.entry?.[0]?.changes?.[0];
  assert.ok(change?.field);
  assert.ok(change.value);
  return { field: change.field, value: change.value };
}

async function signature(
  rawBody: string | Uint8Array,
  secret: string,
): Promise<string> {
  const rawBytes = new Uint8Array(
    typeof rawBody === "string" ? new TextEncoder().encode(rawBody) : rawBody,
  );
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return `sha256=${hexadecimal(
    await crypto.subtle.sign("HMAC", key, rawBytes),
  )}`;
}

test("routes the four subscribed webhook fields explicitly", () => {
  assert.equal(routeWhatsAppChange("messages"), "messages");
  assert.equal(routeWhatsAppChange("history"), "coexistence");
  assert.equal(routeWhatsAppChange("smb_app_state_sync"), "coexistence");
  assert.equal(routeWhatsAppChange("smb_message_echoes"), "coexistence");
  assert.equal(routeWhatsAppChange("future_meta_field"), "unknown");
});

test("verifies the exact HMAC body and rejects an invalid signature", async () => {
  const rawBody = new TextEncoder().encode(JSON.stringify(messagesFixture));
  const secret = "synthetic-meta-app-secret";
  const valid = await signature(rawBody, secret);
  assert.equal(await verifyMetaSignature(rawBody, valid, secret), true);
  assert.equal(
    await verifyMetaSignature(
      new Uint8Array([...rawBody, " ".charCodeAt(0)]),
      valid,
      secret,
    ),
    false,
  );
  assert.equal(await verifyMetaSignature(rawBody, "sha256=00", secret), false);
  assert.equal(
    await verifyMetaSignature(rawBody, valid, "wrong-secret"),
    false,
  );
});

test("bounds streamed webhook bodies before buffering them completely", async () => {
  assert.equal(
    configuredWebhookBodyLimit(undefined),
    DEFAULT_WHATSAPP_WEBHOOK_MAX_BYTES,
  );
  assert.equal(configuredWebhookBodyLimit("131072"), 131072);
  assert.equal(
    configuredWebhookBodyLimit("999999999"),
    DEFAULT_WHATSAPP_WEBHOOK_MAX_BYTES,
  );

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("123"));
      controller.enqueue(encoder.encode("456"));
      controller.close();
    },
  });
  const streamedRequest = new Request("https://example.test/webhook", {
    method: "POST",
    body: stream,
    duplex: "half",
  } as RequestInit);
  await assert.rejects(
    readWhatsAppWebhookBody(streamedRequest, 5),
    WhatsAppWebhookPayloadTooLargeError,
  );

  const declaredRequest = new Request("https://example.test/webhook", {
    method: "POST",
    headers: { "content-length": "10" },
    body: "ok",
  });
  await assert.rejects(
    readWhatsAppWebhookBody(declaredRequest, 5),
    WhatsAppWebhookPayloadTooLargeError,
  );

  const body = await readWhatsAppWebhookBody(
    new Request("https://example.test/webhook", {
      method: "POST",
      body: new Uint8Array([0x7b, 0x7d]),
    }),
    5,
  );
  assert.deepEqual([...body], [0x7b, 0x7d]);
  assert.equal(decodeWhatsAppWebhookBody(body), "{}");
});

test("keeps valid opaque BSUIDs and rejects unsafe identifiers", () => {
  assert.equal(
    normalizeWhatsAppUserId(`  ${TEST_CONTACT_USER_ID}  `),
    TEST_CONTACT_USER_ID,
  );
  assert.equal(normalizeWhatsAppUserId("user id with spaces"), null);
  assert.equal(normalizeWhatsAppUserId("x".repeat(257)), null);
});

test("resolves and validates a status recipient BSUID", () => {
  const value = baseValue({
    contacts: [
      {
        wa_id: "",
        user_id: TEST_CONTACT_USER_ID,
        profile: { username: "paciente_ejemplo" },
      },
    ],
  });
  assert.equal(
    metaStatusRecipientUserId(value, {
      id: "wamid.status.bsuid.1",
      status: "delivered",
      recipient_id: "",
      recipient_user_id: TEST_CONTACT_USER_ID,
    }),
    TEST_CONTACT_USER_ID,
  );
  assert.throws(
    () =>
      metaStatusRecipientUserId(value, {
        id: "wamid.status.bsuid.2",
        status: "read",
        recipient_user_id: "invalid user id",
      }),
    /INVALID_STATUS_RECIPIENT_USER_ID/,
  );
});

test("requires the configured WABA and phone identity", () => {
  const { field, value } = onlyChange(historyFixture);
  assert.equal(
    isExpectedWhatsAppBusinessAccount(TEST_WABA_ID, TEST_WABA_ID),
    true,
  );
  assert.equal(
    isExpectedWhatsAppBusinessAccount("111111111111111", TEST_WABA_ID),
    false,
  );
  assert.equal(
    isTrustedWhatsAppChange(field, value, TEST_PHONE_NUMBER_ID),
    true,
  );
  assert.equal(isTrustedWhatsAppChange(field, value, "111111111111111"), false);
  assert.equal(
    isTrustedWhatsAppChange(
      field,
      { ...value, messaging_product: "another_product" },
      TEST_PHONE_NUMBER_ID,
    ),
    false,
  );
  assert.equal(
    isTrustedWhatsAppChange(
      field,
      { ...value, phone_number_id: "111111111111111" },
      TEST_PHONE_NUMBER_ID,
    ),
    false,
  );
});

test("resolves phone identity independently for every change", () => {
  const first = {
    field: "messages",
    value: baseValue(),
  };
  const second = {
    field: "history",
    value: {
      ...baseValue(),
      metadata: {
        ...baseValue().metadata,
        phone_number_id: "222222222222222",
      },
      phone_number_id: "222222222222222",
    },
  };

  assert.equal(metaChangePhoneNumberId(first), TEST_PHONE_NUMBER_ID);
  assert.equal(metaChangePhoneNumberId(second), "222222222222222");
  assert.equal(
    metaChangePhoneNumberId({
      field: "messages",
      value: {
        messaging_product: "whatsapp",
        phone_number_id: TEST_PHONE_NUMBER_ID,
      },
    }),
    TEST_PHONE_NUMBER_ID,
  );
  assert.equal(
    metaChangePhoneNumberId({
      field: "messages",
      value: {
        ...baseValue(),
        phone_number_id: "222222222222222",
      },
    }),
    null,
  );
  assert.equal(
    metaChangePhoneNumberId({
      field: "account_update",
      value: { event: "ACCOUNT_RECONNECTED" },
    }),
    null,
  );
  assert.equal(
    metaChangePhoneNumberId({
      field: "messages",
      value: {
        messaging_product: "whatsapp",
        phone_number_id: "not-a-phone-id",
      },
    }),
    null,
  );
});

test("keeps account lifecycle WABA-scoped and phone events phone-scoped", () => {
  assert.equal(whatsappChangeIdentityScope("account_update"), "waba");
  assert.equal(
    whatsappChangeIdentityScope("message_template_status_update"),
    "waba",
  );
  assert.equal(whatsappChangeIdentityScope("messages"), "phone");
  assert.equal(whatsappChangeIdentityScope("history"), "phone");
  assert.equal(
    whatsappChangeIdentityScope("phone_number_quality_update"),
    "phone",
  );
  assert.equal(whatsappChangeIdentityScope("future_meta_field"), "unknown");
});

test("routes PARTNER_REMOVED by its explicit WABA and sanitizes disconnection info", () => {
  assert.deepEqual(
    metaAccountUpdateIdentity("1111111111", {
      event: "PARTNER_REMOVED",
      waba_info: {
        waba_id: "2222222222",
        owner_business_id: "3333333333",
      },
      disconnection_info: {
        reason: "PRIMARY_INACTIVITY",
        initiated_by: "SYSTEM",
      },
    }),
    {
      wabaId: "2222222222",
      ownerBusinessId: "3333333333",
      disconnectionReason: "PRIMARY_INACTIVITY",
      disconnectionInitiatedBy: "SYSTEM",
    },
  );
  assert.deepEqual(
    metaAccountUpdateIdentity("1111111111", {
      event: "ACCOUNT_OFFBOARDED",
    }),
    {
      wabaId: "1111111111",
      ownerBusinessId: null,
      disconnectionReason: null,
      disconnectionInitiatedBy: null,
    },
  );
  assert.equal(
    metaAccountUpdateIdentity("1111111111", {
      event: "PARTNER_REMOVED",
      disconnection_info: {
        reason: "sensitive free-form detail",
        initiated_by: "OTHER",
      },
    }),
    null,
  );
});

test("builds a stable duplicate key and safe metadata", async () => {
  const { field, value } = onlyChange(stateSyncFixture);
  const first = await metaChangeEventId(TEST_WABA_ID, field, value);
  const duplicate = await metaChangeEventId(TEST_WABA_ID, field, value);
  assert.equal(first, duplicate);
  assert.match(first, /^change:smb_app_state_sync:[0-9a-f]{64}$/);
  assert.notEqual(
    first,
    await metaChangeEventId(TEST_WABA_ID, field, {
      ...value,
      event: "changed",
    }),
  );
  const firstLifecycle = await metaChangeEventId(
    TEST_WABA_ID,
    "account_update",
    { event: "PARTNER_REMOVED" },
    1_800_000_000,
  );
  assert.equal(
    firstLifecycle,
    await metaChangeEventId(
      TEST_WABA_ID,
      "account_update",
      { event: "PARTNER_REMOVED" },
      "1800000000",
    ),
  );
  assert.notEqual(
    firstLifecycle,
    await metaChangeEventId(
      TEST_WABA_ID,
      "account_update",
      { event: "PARTNER_REMOVED" },
      1_800_000_001,
    ),
  );
  assert.deepEqual(metaWebhookEntryTimestamp("1800000000"), {
    iso: new Date(1_800_000_000 * 1_000).toISOString(),
    unix: "1800000000",
  });
  assert.equal(metaWebhookEntryTimestamp("not-a-timestamp"), null);

  const metadata = safeWebhookMetadata(
    TEST_WABA_ID,
    field,
    value,
    1_800_000_000,
  );
  assert.deepEqual(metadata.counts, { state_sync: 2 });
  assert.equal(
    metadata.entry_time,
    new Date(1_800_000_000 * 1_000).toISOString(),
  );
  assert.equal("state_sync" in metadata, false);
});

test("only treats the explicit stale sync authorization error as ignorable", () => {
  assert.equal(
    isIgnorableCoexistenceSyncRejection(
      "RPC failed: WHATSAPP_COEXISTENCE_SYNC_EVENT_NOT_AUTHORIZED",
    ),
    true,
  );
  assert.equal(
    isIgnorableCoexistenceSyncRejection("WHATSAPP_COEXISTENCE_EVENT_INVALID"),
    false,
  );
  assert.equal(isIgnorableCoexistenceSyncRejection(null), false);
});

test("normalizes history messages without requiring `to` or delivery order", () => {
  const { field, value } = onlyChange(historyFixture);
  const operations = coexistenceOperations(field, value);
  assert.equal(operations.length, 5);
  const messages = operations.filter((item) => item.kind === "message");
  assert.deepEqual(
    messages.map((item) => item.batch?.chunkOrder),
    [2, 2, 1],
  );
  assert.equal(messages[0]?.direction, "inbound");
  assert.equal(messages[0]?.contactPhoneE164, null);
  assert.equal(messages[0]?.contactWhatsAppUserId, TEST_CONTACT_USER_ID);
  assert.equal(messages[0]?.status, "read");
  assert.equal(messages[1]?.direction, "outbound");
  assert.equal(messages[1]?.storedType, "system");
  assert.equal(messages[2]?.direction, "outbound");
  assert.equal(messages[2]?.contactWhatsAppUserId, TEST_CONTACT_USER_ID);
  assert.equal(messages[2]?.status, "delivered");
  assert.deepEqual(
    operations
      .filter((item) => item.kind === "batch")
      .map((item) => item.batch.progress),
    [50, 25],
  );
});

test("marks a later history media payload as wamid-only enrichment", () => {
  const { field, value } = onlyChange(historyMediaFollowUpFixture);
  const operations = coexistenceOperations(field, value);
  assert.equal(operations.length, 1);
  const media = operations[0];
  assert.equal(media.kind, "message");
  if (media.kind !== "message") return;
  assert.equal(media.externalMessageId, "wamid.history.placeholder.2");
  assert.equal(media.metadata.media_follow_up, true);
  assert.equal(media.storedType, "image");
  assert.equal(media.metadata.media_id, "media.synthetic.1");
  assert.equal(media.metadata.mime_type, "image/jpeg");
});

test("accepts outbound history media from message_echoes as wamid-only enrichment", () => {
  const { field, value } = onlyChange(historyOutboundMediaFollowUpFixture);
  const operations = coexistenceOperations(field, value);
  assert.equal(operations.length, 1);
  const media = operations[0];
  assert.equal(media.kind, "message");
  if (media.kind !== "message") return;
  assert.equal(media.externalMessageId, "wamid.history.outbound-media.1");
  assert.equal(media.metadata.media_follow_up, true);
  assert.equal(media.storedType, "document");
  assert.equal(media.metadata.media_id, "media.synthetic.outbound.1");
  assert.equal(media.contactPhoneE164, null);
  assert.equal(media.contactWhatsAppUserId, TEST_CONTACT_USER_ID);
});

test("keeps an empty history batch so progress 100 is durable", () => {
  const operations = coexistenceOperations(
    "history",
    baseValue({
      history: [
        {
          metadata: { phase: 2, chunk_order: 4, progress: 100 },
          threads: [],
        },
      ],
    }),
  );
  assert.equal(operations.length, 1);
  const batch = operations[0];
  assert.equal(batch.kind, "batch");
  if (batch.kind !== "batch") return;
  assert.equal(batch.batch.itemCount, 0);
  assert.equal(batch.batch.progress, 100);
});

test("keeps a declined history sync terminal instead of adding an empty batch", () => {
  const { field, value } = onlyChange(historyDeclinedFixture);
  const operations = coexistenceOperations(field, value);
  assert.equal(operations.length, 2);
  const failure = operations[0];
  assert.equal(failure.kind, "history_error");
  if (failure.kind !== "history_error") return;
  assert.equal(failure.code, 2593109);
  assert.equal(failure.errorIndex, 0);
  assert.deepEqual(failure.metadata.error_data, {
    details: "Synthetic fixture",
  });
  const secondFailure = operations[1];
  assert.equal(secondFailure.kind, "history_error");
  if (secondFailure.kind !== "history_error") return;
  assert.equal(secondFailure.code, 131009);
  assert.equal(secondFailure.errorIndex, 1);
});

test("normalizes state-sync additions and out-of-order removals", () => {
  const { field, value } = onlyChange(stateSyncFixture);
  const operations = coexistenceOperations(field, value);
  assert.equal(operations.length, 2);
  assert.deepEqual(
    operations.map((item) => item.kind === "contact" && item.action),
    ["add", "remove"],
  );
  const [newer, older] = operations;
  assert.equal(newer.kind, "contact");
  assert.equal(older.kind, "contact");
  if (newer.kind !== "contact" || older.kind !== "contact") return;
  assert.ok(new Date(newer.sourceTimestamp) > new Date(older.sourceTimestamp));
  assert.equal(newer.whatsappId, null);
  assert.equal(newer.phoneE164, null);
  assert.equal(newer.whatsappUserId, TEST_CONTACT_USER_ID);
});

test("normalizes echoes as already-sent outbound messages and mutations", () => {
  const { field, value } = onlyChange(messageEchoesFixture);
  const operations = coexistenceOperations(field, value);
  assert.equal(operations.length, 3);
  for (const operation of operations) {
    assert.equal(operation.kind, "message");
    if (operation.kind !== "message") continue;
    assert.equal(operation.direction, "outbound");
    assert.equal(operation.status, "sent");
    assert.equal(operation.contactWhatsAppId, null);
    assert.equal(operation.contactPhoneE164, null);
    assert.equal(operation.contactWhatsAppUserId, TEST_CONTACT_USER_ID);
  }
  const edit = operations[1];
  const revoke = operations[2];
  assert.equal(edit.kind === "message" && edit.messageType, "edit");
  assert.equal(
    edit.kind === "message" && edit.originalMessageId,
    "wamid.echo.text.1",
  );
  assert.equal(revoke.kind === "message" && revoke.messageType, "revoke");
});

test("extracts validated BSUID echo identities for the webhook pause pre-pass", () => {
  const { value } = onlyChange(messageEchoesFixture);
  assert.deepEqual(appEchoContactIdentities(value), [
    { phoneE164: null, whatsappUserId: TEST_CONTACT_USER_ID },
  ]);
});

test("separates live edit/revoke mutations from normal inbound processing", () => {
  const { value } = onlyChange(liveMutationFixture);
  assert.deepEqual(
    liveMessageMutations(value).map((message) => message.type),
    ["edit", "revoke"],
  );
  const operations = coexistenceOperations("messages", value);
  assert.deepEqual(
    operations.map(
      (operation) => operation.kind === "message" && operation.direction,
    ),
    ["inbound", "inbound"],
  );
});

test("records unknown fields by classification without exposing raw payload", () => {
  const { field, value } = onlyChange(unknownFieldFixture);
  assert.equal(routeWhatsAppChange(field), "unknown");
  assert.deepEqual(safeWebhookMetadata(TEST_WABA_ID, field, value).counts, {});
});

test("rejects malformed coexistence items instead of dropping them", () => {
  assert.throws(
    () => coexistenceOperations("history", baseValue()),
    /INVALID_HISTORY_COLLECTION/,
  );
  assert.throws(
    () => coexistenceOperations("smb_message_echoes", baseValue()),
    /INVALID_MESSAGE_ECHO_COLLECTION/,
  );
  assert.throws(
    () =>
      coexistenceOperations(
        "smb_app_state_sync",
        baseValue({
          state_sync: [
            {
              type: "contact",
              action: "add",
              contact: { phone_number: "not-a-phone" },
              metadata: { timestamp: "1760000000" },
            },
          ],
        }),
      ),
    /INVALID_STATE_SYNC_CONTACT/,
  );
});

test("rejects incoherent history participants instead of importing the business as a contact", () => {
  const fixture = structuredClone(historyFixture);
  const value = fixture.entry?.[0]?.changes?.[0]?.value;
  const history = value?.history?.[0] as {
    threads?: Array<{ messages?: Array<Record<string, unknown>> }>;
  };
  const inbound = history.threads?.[0]?.messages?.[0];
  assert.ok(inbound);
  inbound.to = TEST_CONTACT_PHONE;
  assert.throws(
    () => coexistenceOperations("history", value as MetaValue),
    /INVALID_HISTORY_MESSAGE_PARTICIPANTS/,
  );
});
