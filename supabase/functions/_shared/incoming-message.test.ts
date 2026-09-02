import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.112.2";

import {
  processIncomingMessage,
  requiresHumanReview,
  requiresPriority,
  shouldDispatchIncomingAutomation,
  whatsappConsentDecisionFromText,
} from "./incoming-message.ts";
import type { NormalizedIncomingMessage } from "./incoming-message.ts";

function duplicateMessageClient(
  options: {
    origin?: "cloud_api" | "history";
    bsuidOnly?: boolean;
    coexistenceAccountId?: string | null;
  } = {},
): {
  client: SupabaseClient;
  rpcCalls: string[];
  insertedRows: Array<Record<string, unknown>>;
} {
  const rpcCalls: string[] = [];
  const insertedRows: Array<Record<string, unknown>> = [];
  const client = {
    from(table: string) {
      let action = "select";
      const query = {
        select() {
          return this;
        },
        eq() {
          return this;
        },
        is() {
          return this;
        },
        insert(values: Record<string, unknown>) {
          action = "insert";
          insertedRows.push(values);
          return this;
        },
        async maybeSingle() {
          if (table !== "contacts") throw new Error("UNEXPECTED_QUERY");
          return {
            data: {
              id: "contact-1",
              phone_e164: options.bsuidOnly ? null : "+5491100000001",
              whatsapp_id: options.bsuidOnly ? null : "5491100000001",
              whatsapp_user_id: options.bsuidOnly
                ? "user.syntheticinbound1"
                : null,
              name: "Paciente",
              coverage: null,
              is_existing_patient: false,
              alternate_phone_e164: null,
            },
            error: null,
          };
        },
        async single() {
          if (table !== "messages") throw new Error("UNEXPECTED_QUERY");
          return action === "insert"
            ? { data: null, error: { code: "23505" } }
            : {
                data: {
                  id: "message-1",
                  whatsapp_origin: options.origin ?? "cloud_api",
                  conversation_id: "conversation-1",
                  contact_id: "contact-1",
                  coexistence_account_id: options.coexistenceAccountId ?? null,
                },
                error: null,
              };
        },
      };
      return query;
    },
    async rpc(name: string) {
      rpcCalls.push(name);
      if (name === "get_or_create_open_conversation") {
        return {
          data: {
            id: "conversation-1",
            contact_id: "contact-1",
            automation_mode: "auto",
          },
          error: null,
        };
      }
      if (name === "record_whatsapp_consent") {
        return { data: { id: "consent-1" }, error: null };
      }
      if (name === "promote_whatsapp_history_message_to_live") {
        return {
          data: { message_id: "message-1", promoted: true },
          error: null,
        };
      }
      throw new Error(`UNEXPECTED_RPC:${name}`);
    },
  } as unknown as SupabaseClient;
  return { client, rpcCalls, insertedRows };
}

const duplicateOptOut = {
  externalMessageId: "wamid.retry.optout.1",
  phoneE164: "+5491100000001",
  whatsappId: "5491100000001",
  whatsappUserId: null,
  profileName: "Paciente",
  type: "text" as const,
  body: "STOP",
  metadata: {},
  receivedAt: "2026-08-26T10:00:00.000Z",
};
const COEXISTENCE_ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";

test("ordinary duplicate delivery remains inert", async () => {
  const { client, rpcCalls } = duplicateMessageClient();
  const result = await processIncomingMessage({
    client,
    message: duplicateOptOut,
    automationsEnabled: true,
  });

  assert.equal(result.deduplicated, true);
  assert.equal(result.shouldRunAutomation, false);
  assert.equal(rpcCalls.includes("record_whatsapp_consent"), false);
});

test("accepts a BSUID-only inbound identity without inventing a phone", async () => {
  const { client, insertedRows } = duplicateMessageClient({ bsuidOnly: true });
  const result = await processIncomingMessage({
    client,
    message: {
      ...duplicateOptOut,
      phoneE164: null,
      whatsappId: null,
      whatsappUserId: "user.syntheticinbound1",
    },
    automationsEnabled: false,
  });

  assert.equal(result.deduplicated, true);
  assert.equal(insertedRows.length, 1);
});

test("promotes a historical wamid atomically before resuming live side effects", async () => {
  const { client, rpcCalls } = duplicateMessageClient({ origin: "history" });
  const result = await processIncomingMessage({
    client,
    message: duplicateOptOut,
    automationsEnabled: true,
    resumeSideEffectsOnDuplicate: true,
    reserveAutomationDispatch: true,
  });

  assert.equal(result.messageId, "message-1");
  assert.equal(
    rpcCalls.includes("promote_whatsapp_history_message_to_live"),
    true,
  );
  assert.equal(rpcCalls.includes("record_whatsapp_consent"), true);
});

test("a failed webhook retry resumes idempotent post-insert side effects", async () => {
  const { client, rpcCalls, insertedRows } = duplicateMessageClient();
  const result = await processIncomingMessage({
    client,
    message: duplicateOptOut,
    automationsEnabled: true,
    resumeSideEffectsOnDuplicate: true,
    reserveAutomationDispatch: true,
  });

  assert.equal(result.deduplicated, true);
  assert.equal(result.shouldRunAutomation, false);
  assert.equal(rpcCalls.includes("record_whatsapp_consent"), true);
  assert.equal(
    (insertedRows[0]?.metadata as Record<string, unknown> | undefined)
      ?.automation_dispatch_reserved,
    true,
  );
});

test("binds live Embedded messages to their resolved Coexistence account", async () => {
  const { client, insertedRows } = duplicateMessageClient({
    coexistenceAccountId: COEXISTENCE_ACCOUNT_ID,
  });
  await processIncomingMessage({
    client,
    message: duplicateOptOut,
    automationsEnabled: false,
    coexistenceAccountId: COEXISTENCE_ACCOUNT_ID,
  });
  assert.equal(insertedRows[0]?.coexistence_account_id, COEXISTENCE_ACCOUNT_ID);
});

test("rejects a duplicate wamid owned by another account", async () => {
  const { client } = duplicateMessageClient({
    coexistenceAccountId: "33333333-3333-4333-8333-333333333333",
  });
  await assert.rejects(
    processIncomingMessage({
      client,
      message: duplicateOptOut,
      automationsEnabled: false,
      coexistenceAccountId: COEXISTENCE_ACCOUNT_ID,
    }),
    /WHATSAPP_MESSAGE_ACCOUNT_CONFLICT/,
  );
});

function textMessage(body: string): NormalizedIncomingMessage {
  return {
    externalMessageId: "wamid.urgency",
    phoneE164: "+5492291414102",
    whatsappId: "5492291414102",
    whatsappUserId: null,
    profileName: "Paciente",
    type: "text",
    body,
    metadata: {},
    receivedAt: "2026-08-29T12:00:00.000Z",
  };
}

test("una transcripción sólo aplica decisiones explícitas de consentimiento", () => {
  assert.equal(
    whatsappConsentDecisionFromText("No quiero recibir más mensajes"),
    "opt_out",
  );
  assert.equal(
    whatsappConsentDecisionFromText("Por favor quiero darme de baja"),
    "opt_out",
  );
  assert.equal(
    whatsappConsentDecisionFromText("Acepto recibir recordatorios de turnos"),
    "opt_in",
  );
  assert.equal(
    whatsappConsentDecisionFromText(
      "No quiero recibir más mensajes promocionales, pero confirmame el turno",
    ),
    null,
  );
});

function newInboundMediaClient(): {
  client: SupabaseClient;
  rpcCalls: string[];
} {
  const rpcCalls: string[] = [];
  const contact = {
    id: "contact-1",
    phone_e164: "+5492291414102",
    whatsapp_id: "5492291414102",
    whatsapp_user_id: null,
    name: "Paciente",
    coverage: null,
    is_existing_patient: false,
    alternate_phone_e164: null,
  };
  const client = {
    from(table: string) {
      const query = {
        select() {
          return this;
        },
        eq() {
          return this;
        },
        insert() {
          return this;
        },
        async maybeSingle() {
          if (table !== "contacts") throw new Error("UNEXPECTED_QUERY");
          return { data: contact, error: null };
        },
        async single() {
          if (table !== "messages") throw new Error("UNEXPECTED_QUERY");
          return { data: { id: "message-1" }, error: null };
        },
      };
      return query;
    },
    async rpc(name: string) {
      rpcCalls.push(name);
      if (name === "get_or_create_open_conversation") {
        return {
          data: {
            id: "conversation-1",
            contact_id: "contact-1",
            automation_mode: "auto",
          },
          error: null,
        };
      }
      if (name === "pause_whatsapp_automation_for_inbound_handoff") {
        return { data: true, error: null };
      }
      throw new Error(`UNEXPECTED_RPC:${name}`);
    },
  } as unknown as SupabaseClient;
  return { client, rpcCalls };
}

test("urgencies reach Gisela in singular and plural", () => {
  for (const body of [
    "tengo una urgencia",
    "atienden urgencias?",
    "es una emergencia",
    "hacen emergencias los viernes",
    "tengo dolor intenso",
  ]) {
    assert.equal(requiresPriority(textMessage(body)), true, body);
    assert.equal(requiresHumanReview(textMessage(body)), true, body);
  }
});

test("an ordinary booking request keeps using the automated flow", () => {
  for (const body of [
    "hola, quiero sacar un turno",
    "necesito una limpieza",
    "queria consultar por ortodoncia",
  ]) {
    assert.equal(requiresPriority(textMessage(body)), false, body);
    assert.equal(requiresHumanReview(textMessage(body)), false, body);
  }
});

test("clinical content requires review even when it is not an urgency", () => {
  const message = textMessage("Quería consultar por una medicación y la dosis");
  assert.equal(requiresPriority(message), false);
  assert.equal(requiresHumanReview(message), true);
});

test("sin transcripción, una nota de voz nunca continúa sola", () => {
  const audio: NormalizedIncomingMessage = {
    ...textMessage(""),
    type: "audio",
    body: "Nota de voz",
    metadata: { media_id: "1234567890", mime_type: "audio/ogg", voice: true },
  };
  assert.equal(requiresHumanReview(audio), true);
  // Sin transcribir no hay texto que evaluar, así que la prioridad no se
  // infiere de un audio: la marca una persona desde la bandeja.
  assert.equal(requiresPriority(audio), false);
});

test("un adjunto pausado sigue despachando el worker aunque la IA no pueda leerlo", () => {
  assert.equal(
    shouldDispatchIncomingAutomation({
      automationsEnabled: true,
      optedOut: false,
      humanReview: true,
      priority: false,
      owner: false,
      readableMedia: false,
      humanReviewPauseOwned: true,
      automationMode: "manual",
    }),
    true,
  );

  assert.equal(
    shouldDispatchIncomingAutomation({
      automationsEnabled: true,
      optedOut: false,
      humanReview: true,
      priority: false,
      owner: false,
      readableMedia: false,
      humanReviewPauseOwned: false,
      automationMode: "auto",
    }),
    false,
  );
});

test("un handoff manual frena el siguiente inbound sin afectar otra conversación automática", () => {
  const ordinaryInbound = {
    automationsEnabled: true,
    optedOut: false,
    humanReview: false,
    priority: false,
    owner: false,
    readableMedia: false,
    humanReviewPauseOwned: false,
  };

  assert.equal(
    shouldDispatchIncomingAutomation({
      ...ordinaryInbound,
      automationMode: "manual",
    }),
    false,
  );
  assert.equal(
    shouldDispatchIncomingAutomation({
      ...ordinaryInbound,
      automationMode: "auto",
    }),
    true,
  );
});

test("con OPENAI apagado, el inbound se pausa pero no queda sin despachar", async () => {
  const previous = process.env.OPENAI_ADMINISTRATIVE_ENABLED;
  process.env.OPENAI_ADMINISTRATIVE_ENABLED = "false";
  try {
    const { client, rpcCalls } = newInboundMediaClient();
    const result = await processIncomingMessage({
      client,
      message: {
        ...textMessage("Imagen"),
        externalMessageId: "wamid.media.ai-off.1",
        type: "image",
        metadata: {
          media_id: "1234567890",
          mime_type: "image/jpeg",
        },
      },
      automationsEnabled: true,
    });

    assert.equal(result.shouldRunAutomation, true);
    assert.equal(
      rpcCalls.includes("pause_whatsapp_automation_for_inbound_handoff"),
      true,
    );
  } finally {
    if (previous === undefined) {
      delete process.env.OPENAI_ADMINISTRATIVE_ENABLED;
    } else {
      process.env.OPENAI_ADMINISTRATIVE_ENABLED = previous;
    }
  }
});

test("con la automatización global apagada, un adjunto queda marcado para Gisela", async () => {
  const previous = process.env.OPENAI_ADMINISTRATIVE_ENABLED;
  process.env.OPENAI_ADMINISTRATIVE_ENABLED = "true";
  try {
    const { client, rpcCalls } = newInboundMediaClient();
    const result = await processIncomingMessage({
      client,
      message: {
        ...textMessage("Documento"),
        externalMessageId: "wamid.media.global-off.1",
        type: "document",
        metadata: {
          media_id: "1234567890",
          mime_type: "application/pdf",
        },
      },
      automationsEnabled: false,
    });

    assert.equal(result.shouldRunAutomation, false);
    assert.equal(
      rpcCalls.includes("pause_whatsapp_automation_for_inbound_handoff"),
      true,
    );
  } finally {
    if (previous === undefined) {
      delete process.env.OPENAI_ADMINISTRATIVE_ENABLED;
    } else {
      process.env.OPENAI_ADMINISTRATIVE_ENABLED = previous;
    }
  }
});
