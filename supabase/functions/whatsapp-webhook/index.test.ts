import assert from "node:assert/strict";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.112.2";
import {
  isWhatsAppLegacyCredentialsDisabledError,
  managedCoexistenceWebhookAccountId,
  processAccountUpdate,
} from "./index.ts";

Deno.test("sólo reconoce códigos explícitos que deshabilitan legacy", () => {
  assert.equal(
    isWhatsAppLegacyCredentialsDisabledError(
      "rpc: WHATSAPP_LEGACY_CREDENTIALS_DISABLED",
    ),
    true,
  );
  assert.equal(
    isWhatsAppLegacyCredentialsDisabledError(
      "WHATSAPP_CREDENTIAL_RESOLUTION_FAILED",
    ),
    false,
  );
  assert.equal(
    isWhatsAppLegacyCredentialsDisabledError("vault unavailable"),
    false,
  );
});

Deno.test(
  "campos Coexistence y mutaciones nunca crean ni ligan una cuenta legacy",
  () => {
    assert.equal(managedCoexistenceWebhookAccountId({ accountId: null }), null);
    assert.equal(
      managedCoexistenceWebhookAccountId({ accountId: "legacy-tokenless-row" }),
      null,
    );
    assert.equal(managedCoexistenceWebhookAccountId(null), null);
    assert.equal(
      managedCoexistenceWebhookAccountId({
        accountId: "22222222-2222-4222-8222-222222222222",
      }),
      "22222222-2222-4222-8222-222222222222",
    );
  },
);

function lifecycleClient(): {
  client: SupabaseClient;
  lifecycleCalls: Array<Record<string, unknown>>;
  settingsUpdates: Array<Record<string, unknown>>;
} {
  const lifecycleCalls: Array<Record<string, unknown>> = [];
  const settingsUpdates: Array<Record<string, unknown>> = [];
  const client = {
    rpc: async (name: string, parameters: Record<string, unknown>) => {
      assert.equal(name, "apply_whatsapp_coexistence_account_update");
      lifecycleCalls.push(parameters);
      return { data: 1, error: null };
    },
    from: (table: string) => {
      assert.equal(table, "whatsapp_settings");
      return {
        update: (values: Record<string, unknown>) => {
          settingsUpdates.push(values);
          return {
            eq: (column: string, value: unknown) => {
              assert.equal(column, "id");
              assert.equal(value, true);
              return {
                select: (selection: string) => {
                  assert.equal(selection, "id");
                  return {
                    single: async () => ({ data: { id: true }, error: null }),
                  };
                },
              };
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;
  return { client, lifecycleCalls, settingsUpdates };
}

Deno.test(
  "account_update legacy pausa envíos sin mutar una cuenta Embedded inexistente",
  async () => {
    const fake = lifecycleClient();
    await processAccountUpdate(
      fake.client,
      { event: "PARTNER_REMOVED" },
      "1111111111",
      "2026-08-26T12:00:00.000Z",
      false,
    );

    assert.equal(fake.lifecycleCalls.length, 0);
    assert.equal(fake.settingsUpdates.length, 1);
    assert.equal(
      fake.settingsUpdates[0].sending_pause_reason,
      "META_ACCOUNT_PARTNER_REMOVED",
    );
    assert.equal(fake.settingsUpdates[0].sending_paused, true);
  },
);

Deno.test(
  "account_update Embedded persiste lifecycle sin pausar otras cuentas",
  async () => {
    const fake = lifecycleClient();
    await processAccountUpdate(
      fake.client,
      { event: "ACCOUNT_OFFBOARDED" },
      "2222222222",
      "2026-08-26T12:00:00.000Z",
      true,
      {
        wabaId: "2222222222",
        ownerBusinessId: "3333333333",
        disconnectionReason: "PRIMARY_INACTIVITY",
        disconnectionInitiatedBy: "SYSTEM",
      },
    );

    assert.deepEqual(fake.lifecycleCalls, [
      {
        p_waba_id: "2222222222",
        p_event: "ACCOUNT_OFFBOARDED",
        p_event_at: "2026-08-26T12:00:00.000Z",
        p_owner_business_id: "3333333333",
        p_disconnection_reason: "PRIMARY_INACTIVITY",
        p_disconnection_initiated_by: "SYSTEM",
      },
    ]);
    assert.equal(fake.settingsUpdates.length, 0);
  },
);

Deno.test(
  "account_update tardío tras offboarding falla cerrado sin tocar siblings",
  async () => {
    let globalUpdates = 0;
    const client = {
      rpc: async () => ({
        data: null,
        error: { message: "WHATSAPP_COEXISTENCE_ACCOUNT_NOT_FOUND" },
      }),
      from: () => {
        globalUpdates += 1;
        throw new Error("global fallback forbidden");
      },
    } as unknown as SupabaseClient;

    await assert.rejects(
      () =>
        processAccountUpdate(
          client,
          { event: "PARTNER_REMOVED" },
          "2222222222",
          "2026-08-26T12:00:00.000Z",
          true,
        ),
      /WHATSAPP_ACCOUNT_UPDATE_PERSIST_FAILED/,
    );
    assert.equal(globalUpdates, 0);
  },
);
