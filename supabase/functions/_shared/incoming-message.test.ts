import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.112.2";

import { processIncomingMessage } from "./incoming-message.ts";

function duplicateMessageClient(
  options: {
    origin?: "cloud_api" | "history";
    bsuidOnly?: boolean;
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
