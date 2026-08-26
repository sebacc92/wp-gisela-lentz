import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.112.2";

import { updateClaimedReminder } from "./reminder-delivery.ts";

const REMINDER_ID = "66666666-6666-4666-8666-666666666666";
const CLAIMED_AT = "2026-08-26T18:00:00.000Z";

function updateClient(input: { matched: boolean }): {
  client: SupabaseClient;
  filters: Array<[string, unknown]>;
} {
  const filters: Array<[string, unknown]> = [];
  const query = {
    eq(column: string, value: unknown) {
      filters.push([column, value]);
      return query;
    },
    select(selection: string) {
      assert.equal(selection, "id");
      return query;
    },
    async maybeSingle() {
      return {
        data: input.matched ? { id: REMINDER_ID } : null,
        error: null,
      };
    },
  };
  return {
    client: {
      from(table: string) {
        assert.equal(table, "reminders");
        return {
          update(values: Record<string, unknown>) {
            assert.equal(values.status, "pending");
            return query;
          },
        };
      },
    } as unknown as SupabaseClient,
    filters,
  };
}

test("finaliza sólo el reminder y la generación de claim exactos", async () => {
  const fake = updateClient({ matched: true });
  assert.equal(
    await updateClaimedReminder(
      fake.client,
      { id: REMINDER_ID, processingStartedAt: CLAIMED_AT },
      { status: "pending" },
    ),
    true,
  );
  assert.deepEqual(fake.filters, [
    ["id", REMINDER_ID],
    ["status", "processing"],
    ["processing_started_at", CLAIMED_AT],
  ]);
});

test("un worker stale no reabre un reminder cancelado por offboarding", async () => {
  const fake = updateClient({ matched: false });
  assert.equal(
    await updateClaimedReminder(
      fake.client,
      { id: REMINDER_ID, processingStartedAt: CLAIMED_AT },
      { status: "pending", last_error: "SEND_RETRYABLE" },
    ),
    false,
  );
  assert.deepEqual(fake.filters, [
    ["id", REMINDER_ID],
    ["status", "processing"],
    ["processing_started_at", CLAIMED_AT],
  ]);
});
