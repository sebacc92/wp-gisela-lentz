import assert from "node:assert/strict";
import test from "node:test";
import { assertOutboundPolicy } from "./whatsapp.ts";

function policyInput(
  source: string,
  projection: unknown,
  rpcError: unknown = null,
  options: {
    appointment?: Record<string, unknown>;
    conversation?: Record<string, unknown>;
    contact?: Record<string, unknown>;
  } = {},
) {
  const conversation = {
    id: "conversation",
    contact_id: "patient",
    automation_mode: "auto" as const,
    last_inbound_message_at: new Date().toISOString(),
    needs_human: false,
    automation_human_barrier_ingest_sequence: 0,
    ...options.conversation,
  };
  const contact = {
    id: "patient",
    name: "Synthetic",
    phone_e164: "+12025550100",
    whatsapp_id: null,
    whatsapp_user_id: null,
    ...options.contact,
  };
  const confirmation =
    source === "operator_deposit_confirmation" ||
    source === "appointment_confirmation";
  const startsAt = new Date(Date.now() + 86400000).toISOString();
  const endsAt = new Date(Date.now() + 90000000).toISOString();
  const rows: Record<string, unknown> = {
    conversations: conversation,
    contacts: contact,
    whatsapp_settings: { sending_paused: false },
    messages: { whatsapp_ingest_sequence: 1 },
    appointments: {
      id: "appointment",
      contact_id: "patient",
      status: confirmation ? "confirmed" : "scheduled",
      deposit_status:
        source === "appointment_confirmation"
          ? "not_required"
          : confirmation
            ? "confirmed"
            : "pending",
      starts_at: startsAt,
      ends_at: endsAt,
      hold_expires_at: new Date(Date.now() + 3600000).toISOString(),
      ...options.appointment,
    },
  };
  const client = {
    from(table: string) {
      const chain = {
        select: () => chain,
        eq: () => chain,
        single: () => Promise.resolve({ data: rows[table], error: null }),
        maybeSingle: () => Promise.resolve({ data: rows[table], error: null }),
      };
      return chain;
    },
    rpc(name: string, args: Record<string, unknown>) {
      assert.equal(name, "appointment_google_calendar_projection");
      assert.equal(args.p_appointment_id, "appointment");
      return Promise.resolve({ data: projection, error: rpcError });
    },
  } as unknown as Parameters<typeof assertOutboundPolicy>[0]["client"];
  return {
    client,
    conversation,
    contact,
    source,
    type: "text" as const,
    templateName: null,
    templateKey: null,
    appointmentId: "appointment",
    automationOwnerMessageId:
      source === "appointment_confirmation" ? "inbound" : null,
    appointmentSnapshot: { startsAt, endsAt },
  };
}

test("el envío manual exige Calendar aun con seña válida y ventana WhatsApp abierta", async () => {
  for (const source of [
    "operator_deposit_request",
    "operator_deposit_confirmation",
  ]) {
    for (const state of ["pending", "unavailable", "conflict"]) {
      await assert.rejects(
        assertOutboundPolicy(policyInput(source, { state })),
        { message: "WHATSAPP_POLICY:CALENDAR_PROJECTION_PENDING" },
      );
    }
    await assert.rejects(
      assertOutboundPolicy(
        policyInput(
          source,
          { state: "synced", projectionStage: "confirmed" },
          { message: "db error" },
        ),
      ),
      { message: "WHATSAPP_POLICY:CALENDAR_PROJECTION_PENDING" },
    );
  }
});

test("un turno proyectado permite el aviso conservando las reglas normales de WhatsApp", async () => {
  for (const source of [
    "operator_deposit_request",
    "operator_deposit_confirmation",
  ]) {
    await assertOutboundPolicy(
      policyInput(source, {
        state: "synced",
        projectionStage:
          source === "operator_deposit_request"
            ? "pre_reservation"
            : "confirmed",
      }),
    );
  }
});

test("un cambio concurrente de etapa no permite confirmar una pre-reserva ni pedir seña ya confirmada", async () => {
  for (const source of [
    "operator_deposit_request",
    "operator_deposit_confirmation",
  ]) {
    await assert.rejects(
      assertOutboundPolicy(
        policyInput(source, {
          state: "synced",
          projectionStage:
            source === "operator_deposit_request"
              ? "confirmed"
              : "pre_reservation",
        }),
      ),
      { message: "WHATSAPP_POLICY:CALENDAR_PROJECTION_PENDING" },
    );
  }
});

async function withAutomations(run: () => Promise<void>) {
  const previous = process.env.WHATSAPP_AUTOMATIONS_ENABLED;
  process.env.WHATSAPP_AUTOMATIONS_ENABLED = "true";
  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env.WHATSAPP_AUTOMATIONS_ENABLED;
    else process.env.WHATSAPP_AUTOMATIONS_ENABLED = previous;
  }
}

test("un turno sin seña se confirma con la proyección confirmada y sin evidencia bancaria", async () => {
  await withAutomations(async () => {
    await assertOutboundPolicy(
      policyInput("appointment_confirmation", {
        state: "synced",
        projectionStage: "confirmed",
      }),
    );
  });
});

test("la confirmación sin seña rechaza pago pendiente, cancelación, otro paciente o un horario distinto", async () => {
  await withAutomations(async () => {
    for (const appointment of [
      { status: "scheduled", deposit_status: "pending" },
      { status: "cancelled" },
      { deposit_status: "confirmed" },
      { contact_id: "another-patient" },
      { starts_at: new Date(Date.now() + 172800000).toISOString() },
      { ends_at: new Date(Date.now() + 172800000).toISOString() },
      { starts_at: new Date(Date.now() - 60000).toISOString() },
    ]) {
      await assert.rejects(
        assertOutboundPolicy(
          policyInput(
            "appointment_confirmation",
            {
              state: "synced",
              projectionStage: "confirmed",
            },
            null,
            { appointment },
          ),
        ),
        {
          message: "WHATSAPP_POLICY:APPOINTMENT_CONFIRMATION_STALE",
        },
      );
    }
    const missingSnapshot = policyInput("appointment_confirmation", {
      state: "synced",
      projectionStage: "confirmed",
    });
    await assert.rejects(
      assertOutboundPolicy({ ...missingSnapshot, appointmentSnapshot: null }),
      {
        message: "WHATSAPP_POLICY:APPOINTMENT_CONFIRMATION_STALE",
      },
    );
  });
});

test("la exención de seña no omite Google Calendar ni permite confirmar una proyección pendiente", async () => {
  await withAutomations(async () => {
    for (const projection of [
      { state: "pending" },
      { state: "conflict" },
      { state: "unavailable" },
      { state: "synced", projectionStage: "pre_reservation" },
      null,
    ]) {
      await assert.rejects(
        assertOutboundPolicy(
          policyInput("appointment_confirmation", projection),
        ),
        {
          message: "WHATSAPP_POLICY:CALENDAR_PROJECTION_PENDING",
        },
      );
    }
  });
});

test("la confirmación exenta conserva ventana, pausa humana, baja y kill switch", async () => {
  await withAutomations(async () => {
    const projection = { state: "synced", projectionStage: "confirmed" };
    for (const [conversation, code] of [
      [
        {
          last_inbound_message_at: new Date(
            Date.now() - 86400001,
          ).toISOString(),
        },
        "CUSTOMER_SERVICE_WINDOW_CLOSED",
      ],
      [{ automation_mode: "manual" }, "AUTOMATION_PAUSED"],
      [
        { automation_human_barrier_ingest_sequence: 1 },
        "AUTOMATION_SUPERSEDED_BY_HUMAN_REPLY",
      ],
    ] as const) {
      await assert.rejects(
        assertOutboundPolicy(
          policyInput("appointment_confirmation", projection, null, {
            conversation,
          }),
        ),
        {
          message: `WHATSAPP_POLICY:${code}`,
        },
      );
    }
    const optedOutAt = Date.now();
    await assert.rejects(
      assertOutboundPolicy(
        policyInput("appointment_confirmation", projection, null, {
          conversation: {
            last_inbound_message_at: new Date(optedOutAt - 60000).toISOString(),
          },
          contact: { whatsapp_opt_out_at: new Date(optedOutAt).toISOString() },
        }),
      ),
      { message: "WHATSAPP_POLICY:CONTACT_OPTED_OUT" },
    );
    await assert.rejects(
      assertOutboundPolicy({
        ...policyInput("appointment_confirmation", projection),
        type: "template",
      }),
      { message: "WHATSAPP_POLICY:APPOINTMENT_CONFIRMATION_CONTEXT_INVALID" },
    );
    process.env.WHATSAPP_AUTOMATIONS_ENABLED = "false";
    await assert.rejects(
      assertOutboundPolicy(policyInput("appointment_confirmation", projection)),
      {
        message: "WHATSAPP_POLICY:AUTOMATIONS_DISABLED",
      },
    );
  });
});
