import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.112.2";
import {
  assertPrivateOwnerDispatch,
  isCustomerServiceWindowOpen,
} from "./whatsapp.ts";

const PHONE = "+5491112345678";
const SECOND = "+5491112345679";
const NOW = Date.parse("2026-09-07T00:00:00Z");

function client(
  inbound: Record<string, unknown>,
  optedOut = false,
): SupabaseClient {
  return {
    from(table: string) {
      const value =
        table === "messages"
          ? inbound
          : table === "app_settings"
            ? { automations_enabled: true }
            : { whatsapp_consent_status: optedOut ? "opted_out" : "unknown" };
      const query = {
        select() {
          return query;
        },
        eq() {
          return query;
        },
        async maybeSingle() {
          return { data: value, error: null };
        },
        async single() {
          return { data: value, error: null };
        },
      };
      return query;
    },
  } as unknown as SupabaseClient;
}

function setup(t: TestContext) {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const owner = process.env.WHATSAPP_OWNER_NUMBERS;
  const enabled = process.env.WHATSAPP_OWNER_DAILY_SUMMARY_ENABLED;
  process.env.WHATSAPP_OWNER_NUMBERS = PHONE;
  process.env.WHATSAPP_OWNER_DAILY_SUMMARY_ENABLED = "true";
  t.after(() => {
    if (owner === undefined) delete process.env.WHATSAPP_OWNER_NUMBERS;
    else process.env.WHATSAPP_OWNER_NUMBERS = owner;
    if (enabled === undefined)
      delete process.env.WHATSAPP_OWNER_DAILY_SUMMARY_ENABLED;
    else process.env.WHATSAPP_OWNER_DAILY_SUMMARY_ENABLED = enabled;
  });
}

const validInbound = {
  metadata: {
    sender_identity_source: "signed_meta_webhook",
    verified_sender_phone_e164: PHONE,
  },
  created_at: "2026-09-06T23:00:00Z",
  whatsapp_origin: "cloud_api",
};
const args = {
  source: "owner_access",
  type: "text",
  contactId: "contact",
  conversationId: "conversation",
  recipient: { kind: "wa_id", value: PHONE.slice(1) },
  metadata: { inbound_message_id: "inbound" },
};

test("el destinatario real de Graph debe coincidir con el remitente firmado autorizado", async (t) => {
  setup(t);
  await assertPrivateOwnerDispatch({ ...args, client: client(validInbound) });
  for (const recipient of [
    { kind: "wa_id", value: "5491112345679" },
    { kind: "bsuid", value: "AR.secret" },
  ])
    await assert.rejects(
      assertPrivateOwnerDispatch({
        ...args,
        recipient,
        client: client(validInbound),
      }),
      /OWNER_RECIPIENT_UNVERIFIED/,
    );
  // Con dos teléfonos autorizados la evidencia sigue siendo de cada mensaje:
  // el otro número de la allowlist tampoco puede recibir esta respuesta.
  process.env.WHATSAPP_OWNER_NUMBERS = `${PHONE},${SECOND}`;
  await assertPrivateOwnerDispatch({ ...args, client: client(validInbound) });
  await assert.rejects(
    assertPrivateOwnerDispatch({
      ...args,
      recipient: { kind: "wa_id", value: SECOND.slice(1) },
      client: client(validInbound),
    }),
    /OWNER_RECIPIENT_UNVERIFIED/,
  );
});

test("historial, metadata ausente y ventana vencida no autorizan información privada", async (t) => {
  setup(t);
  for (const override of [
    { whatsapp_origin: "history" },
    { metadata: {} },
    { created_at: "2026-09-06T00:00:00Z" },
    { created_at: "2026-09-07T00:00:01Z" },
  ])
    await assert.rejects(
      assertPrivateOwnerDispatch({
        ...args,
        client: client({ ...validInbound, ...override }),
      }),
      /OWNER_RECIPIENT_UNVERIFIED|CUSTOMER_SERVICE_WINDOW_CLOSED/,
    );
});

test("el resumen nunca usa plantilla, respeta BAJA y revalida hora al despachar", async (t) => {
  setup(t);
  const digest = {
    ...args,
    source: "owner_daily_summary",
    metadata: { ...args.metadata, owner_summary_date: "2026-09-06" },
  };
  await assertPrivateOwnerDispatch({ ...digest, client: client(validInbound) });
  await assert.rejects(
    assertPrivateOwnerDispatch({
      ...digest,
      type: "template",
      client: client(validInbound),
    }),
    /OWNER_RECIPIENT_UNVERIFIED/,
  );
  await assert.rejects(
    assertPrivateOwnerDispatch({
      ...digest,
      client: client(validInbound, true),
    }),
    /CONTACT_OPTED_OUT/,
  );
  t.mock.timers.setTime(NOW + 15 * 60 * 1000);
  await assert.rejects(
    assertPrivateOwnerDispatch({ ...digest, client: client(validInbound) }),
    /OWNER_SUMMARY_NOT_DUE/,
  );
});

test("ningún timestamp futuro abre la ventana de 24 horas", (t) => {
  setup(t);
  assert.equal(
    isCustomerServiceWindowOpen(new Date(NOW + 1).toISOString()),
    false,
  );
  assert.equal(
    isCustomerServiceWindowOpen(new Date(NOW - 86_400_000).toISOString()),
    false,
  );
  assert.equal(
    isCustomerServiceWindowOpen(new Date(NOW - 86_399_999).toISOString()),
    true,
  );
});
