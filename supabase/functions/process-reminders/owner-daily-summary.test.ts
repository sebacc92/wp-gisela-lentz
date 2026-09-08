import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.112.2";
import { processOwnerDailySummary } from "./owner-daily-summary.ts";
import { activeOwnerAppointment } from "../_shared/owner-agenda.ts";
import { WhatsAppPolicyError } from "../_shared/whatsapp.ts";

const NOW = Date.parse("2026-09-07T00:00:00Z");
const PHONE = "+5491112345678";
const SECOND = "+5491112345679";

type SendArgs = Parameters<
  NonNullable<Parameters<typeof processOwnerDailySummary>[0]["send"]>
>[0];

function setup(t: TestContext) {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const old = process.env.WHATSAPP_AUTOMATIONS_ENABLED;
  process.env.WHATSAPP_AUTOMATIONS_ENABLED = "true";
  t.after(() => {
    if (old === undefined) delete process.env.WHATSAPP_AUTOMATIONS_ENABLED;
    else process.env.WHATSAPP_AUTOMATIONS_ENABLED = old;
  });
}

function sent(outbound: SendArgs) {
  return {
    id: `sent-${outbound.contact.phone_e164}`,
    whatsapp_message_id: "wamid.fake",
    status: "sent" as const,
    deduplicated: false,
  };
}

/** Cada teléfono autorizado tiene su propio contacto, conversación, entrante
 * verificado y fila del ledger: la maqueta no puede confundirlos entre sí. */
function fake(
  input: {
    inboundAt?: string;
    optedOut?: boolean;
    paused?: boolean;
    priorBody?: string;
    known?: string[];
  } = {},
) {
  const known = input.known ?? [PHONE];
  const ledger = new Map<string, Record<string, unknown>>();
  const calls: Array<{ table: string; filters: Array<[string, unknown]> }> = [];
  const claims: Array<Record<string, unknown>> = [];
  const lastInbound = input.inboundAt ?? "2026-09-06T23:00:00Z";
  const phoneOf = (id: unknown) => String(id).split(":")[1];
  const client = {
    from(table: string) {
      assert.notEqual(
        table,
        "message_templates",
        "El resumen no puede usar plantillas",
      );
      const trace = { table, filters: [] as Array<[string, unknown]> };
      calls.push(trace);
      let update: Record<string, unknown> | null = null;
      const filter = (key: string) =>
        trace.filters.find(([name]) => name === key)?.[1];
      const ledgerKey = () =>
        trace.filters.some(([name]) => name === "id")
          ? phoneOf(filter("id"))
          : String(filter("recipient_phone_e164"));
      const value = () => {
        if (table === "app_settings") return { automations_enabled: true };
        if (table === "contacts") {
          const phone = String(filter("phone_e164"));
          if (!known.includes(phone)) return null;
          return {
            id: `contact:${phone}`,
            name: "Autorizada",
            phone_e164: phone,
            whatsapp_id: phone.slice(1),
            whatsapp_user_id: null,
            whatsapp_consent_status: input.optedOut ? "opted_out" : "unknown",
          };
        }
        if (table === "conversations")
          return {
            id: `conversation:${phoneOf(filter("contact_id"))}`,
            contact_id: filter("contact_id"),
            status: "open",
            coexistence_account_id: null,
            last_inbound_message_at: lastInbound,
            automation_mode: input.paused ? "manual" : "auto",
            needs_human: false,
          };
        if (table === "messages")
          return {
            id: `inbound:${phoneOf(filter("contact_id"))}`,
            created_at: lastInbound,
            metadata: {
              sender_identity_source: "signed_meta_webhook",
              verified_sender_phone_e164: phoneOf(filter("contact_id")),
            },
          };
        if (table === "appointments")
          return [
            {
              starts_at: "2026-09-07T13:00:00Z",
              coverage: "particular",
              status: "confirmed",
              hold_expires_at: null,
              deposit_status: "not_required",
              contacts: { name: "Paciente prueba" },
            },
          ];
        if (table === "google_calendar_connections")
          return {
            status: "connected",
            connection_generation: 1,
            last_sync_completed_at: new Date(NOW).toISOString(),
          };
        if (table === "google_calendar_external_events")
          return [
            {
              starts_at: "2026-09-07T15:00:00Z",
              ends_at: "2026-09-07T16:00:00Z",
              all_day: false,
              connection_generation: 1,
            },
          ];
        if (table === "whatsapp_owner_daily_summaries")
          return ledger.get(ledgerKey()) ?? null;
        throw new Error(`Tabla inesperada ${table}`);
      };
      const result = () => {
        const current = value();
        if (update && current && table === "whatsapp_owner_daily_summaries") {
          ledger.set(ledgerKey(), {
            ...(current as Record<string, unknown>),
            ...update,
          });
        }
        return { data: value(), error: null };
      };
      const query = {
        select() {
          return query;
        },
        update(patch: Record<string, unknown>) {
          update = patch;
          return query;
        },
        eq(key: string, val: unknown) {
          trace.filters.push([key, val]);
          return query;
        },
        gte(key: string, val: unknown) {
          trace.filters.push([`gte:${key}`, val]);
          return query;
        },
        lt(key: string, val: unknown) {
          trace.filters.push([`lt:${key}`, val]);
          return query;
        },
        gt(key: string, val: unknown) {
          trace.filters.push([`gt:${key}`, val]);
          return query;
        },
        in() {
          return query;
        },
        contains() {
          return query;
        },
        order() {
          return query;
        },
        limit() {
          return query;
        },
        async single() {
          return result();
        },
        async maybeSingle() {
          return result();
        },
        then(resolve: (v: unknown) => unknown) {
          return Promise.resolve(result()).then(resolve);
        },
      };
      return query;
    },
    async rpc(name: string, args: Record<string, unknown>) {
      assert.equal(name, "claim_whatsapp_owner_daily_summary");
      claims.push(args);
      const phone = String(args.p_recipient_phone);
      const row = {
        id: `summary:${phone}`,
        summary_date: "2026-09-06",
        recipient_phone_e164: phone,
        contact_id: args.p_contact_id,
        conversation_id: args.p_conversation_id,
        inbound_message_id: args.p_inbound_message_id,
        body: input.priorBody ?? args.p_body,
        status: args.p_skip_reason ? "skipped" : "processing",
        reason: args.p_skip_reason,
        processing_started_at: new Date(NOW).toISOString(),
        attempts: 1,
      };
      ledger.set(phone, row);
      return { data: [row], error: null };
    },
  } as unknown as SupabaseClient;
  return {
    client,
    calls,
    claims,
    ledger: (phone = PHONE) => ledger.get(phone) ?? null,
  };
}

test("a las 21 envía una sola agenda de mañana en texto, incluye ocupados Google y registra envío", async (t) => {
  setup(t);
  const f = fake();
  let delivered = 0;
  const args = {
    client: f.client,
    enabled: true,
    ownerNumbers: new Set([PHONE]),
    send: async (outbound: SendArgs) => {
      delivered += 1;
      assert.equal(outbound.payload.type, "text");
      assert.equal(
        outbound.idempotencyKey,
        `owner-summary:2026-09-06:summary:${PHONE}`,
      );
      assert.match(outbound.bodyPreview, /10:00 · Paciente prueba/);
      assert.match(outbound.bodyPreview, /12:00–13:00 · Ocupado/);
      assert.equal(outbound.metadata?.inbound_message_id, `inbound:${PHONE}`);
      return sent(outbound);
    },
  };
  assert.equal((await processOwnerDailySummary(args)).status, "sent");
  assert.equal(
    (await processOwnerDailySummary(args)).reason,
    "OWNER_SUMMARY_ALREADY_PROCESSED",
  );
  assert.equal(delivered, 1);
  const appointmentQuery = f.calls.find(
    (call) => call.table === "appointments",
  );
  assert.ok(
    appointmentQuery?.filters.some(
      ([key, value]) =>
        key === "gte:starts_at" && value === "2026-09-07T03:00:00.000Z",
    ),
  );
  assert.equal(f.ledger()?.message_id, `sent-${PHONE}`);
});

test("cada teléfono autorizado recibe su propio despacho y la agenda se arma una sola vez", async (t) => {
  setup(t);
  const f = fake({ known: [PHONE, SECOND] });
  const delivered: string[] = [];
  const result = await processOwnerDailySummary({
    client: f.client,
    enabled: true,
    ownerNumbers: new Set([SECOND, PHONE]),
    send: async (outbound: SendArgs) => {
      delivered.push(outbound.contact.phone_e164 as string);
      // Cada resumen viaja atado a la evidencia de su propio destinatario.
      assert.equal(
        outbound.metadata?.inbound_message_id,
        `inbound:${outbound.contact.phone_e164}`,
      );
      return sent(outbound);
    },
  });
  assert.equal(result.status, "sent");
  assert.equal(result.reason, null);
  assert.deepEqual(delivered, [PHONE, SECOND]);
  assert.deepEqual(
    f.claims.map((claim) => claim.p_recipient_phone),
    [PHONE, SECOND],
  );
  assert.deepEqual(
    f.claims.map((claim) => claim.p_contact_id),
    [`contact:${PHONE}`, `contact:${SECOND}`],
  );
  assert.equal(f.ledger(SECOND)?.message_id, `sent-${SECOND}`);
  assert.equal(
    f.calls.filter((call) => call.table === "appointments").length,
    1,
  );
});

test("un destinatario sin ventana no frena el resumen del otro", async (t) => {
  setup(t);
  const f = fake({ known: [PHONE] });
  let delivered = 0;
  const result = await processOwnerDailySummary({
    client: f.client,
    enabled: true,
    ownerNumbers: new Set([PHONE, SECOND]),
    send: async (outbound: SendArgs) => {
      delivered += 1;
      return sent(outbound);
    },
  });
  assert.equal(delivered, 1);
  assert.equal(result.status, "sent");
  assert.equal(result.reason, "OWNER_SUMMARY_PARTIAL");
  assert.deepEqual(result.recipients, [
    { status: "sent", reason: null },
    { status: "skipped", reason: "OWNER_HAS_NOT_MESSAGED" },
  ]);
  assert.equal(f.ledger(SECOND)?.reason, "OWNER_HAS_NOT_MESSAGED");
  assert.equal(f.ledger(SECOND)?.body, null);
});

test("sin ventana, con BAJA o pausa registra omisión sin leer la agenda ni enviar", async (t) => {
  setup(t);
  for (const input of [
    { inboundAt: "2026-09-06T00:00:00Z" },
    { optedOut: true },
    { paused: true },
  ]) {
    const f = fake(input);
    const result = await processOwnerDailySummary({
      client: f.client,
      enabled: true,
      ownerNumbers: new Set([PHONE]),
      send: () => {
        throw new Error("No debe enviar");
      },
    });
    assert.equal(result.status, "skipped");
    assert.equal(f.ledger()?.status, "skipped");
    assert.equal(
      f.calls.some((call) => call.table === "appointments"),
      false,
    );
  }
});

test("reintento usa el texto guardado aunque la agenda cambie y ventana vencida al enviar se omite", async (t) => {
  setup(t);
  const f = fake({ priorBody: "Snapshot de la primera ejecución" });
  const result = await processOwnerDailySummary({
    client: f.client,
    enabled: true,
    ownerNumbers: new Set([PHONE]),
    send: (outbound) => {
      assert.equal(outbound.bodyPreview, "Snapshot de la primera ejecución");
      throw new WhatsAppPolicyError("CUSTOMER_SERVICE_WINDOW_CLOSED");
    },
  });
  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "CUSTOMER_SERVICE_WINDOW_CLOSED");
  assert.deepEqual(result.recipients, [
    { status: "skipped", reason: "CUSTOMER_SERVICE_WINDOW_CLOSED" },
  ]);
});

test("fuera del horario o sin allowlist configurada no consulta datos privados", async (t) => {
  setup(t);
  const f = fake();
  assert.equal(
    (
      await processOwnerDailySummary({
        client: f.client,
        enabled: true,
        ownerNumbers: new Set(),
      })
    ).reason,
    "OWNER_NUMBER_NOT_CONFIGURED",
  );
  t.mock.timers.setTime(NOW + 15 * 60 * 1000);
  assert.equal(
    (
      await processOwnerDailySummary({
        client: f.client,
        enabled: true,
        ownerNumbers: new Set([PHONE]),
      })
    ).reason,
    "OWNER_SUMMARY_NOT_DUE",
  );
  assert.equal(f.calls.length, 0);
});

test("las pre-reservas con seña pendiente o comprobante vencido no figuran activas", () => {
  const base = {
    status: "scheduled",
    deposit_status: "pending",
    hold_expires_at: new Date(NOW - 1).toISOString(),
  };
  assert.equal(activeOwnerAppointment(base, new Date(NOW)), false);
  assert.equal(
    activeOwnerAppointment(
      { ...base, deposit_status: "proof_received" },
      new Date(NOW),
    ),
    false,
  );
  assert.equal(
    activeOwnerAppointment(
      { ...base, hold_expires_at: new Date(NOW + 1).toISOString() },
      new Date(NOW),
    ),
    true,
  );
  assert.equal(
    activeOwnerAppointment({ ...base, status: "confirmed" }, new Date(NOW)),
    true,
  );
});
