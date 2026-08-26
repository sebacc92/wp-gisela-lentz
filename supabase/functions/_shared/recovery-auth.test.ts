import assert from "node:assert/strict";
import test from "node:test";

import { authorizeProcessorRequest } from "./recovery-auth.ts";

const INTERNAL_SECRET = "11".repeat(32);
const COEXISTENCE_RECOVERY_SECRET = "22".repeat(32);
const OUTBOX_RECOVERY_SECRET = "33".repeat(32);

function request(headers: Record<string, string> = {}): Request {
  return new Request("https://example.test/functions/v1/processor", {
    method: "POST",
    headers,
  });
}

async function authorized(
  headers: Record<string, string>,
  recoverySecret = COEXISTENCE_RECOVERY_SECRET,
  internalSecret = INTERNAL_SECRET,
): Promise<boolean> {
  return await authorizeProcessorRequest(
    request(headers),
    internalSecret,
    recoverySecret,
  );
}

test("preserves the original internal processor credential", async () => {
  assert.equal(
    await authorized({ "x-internal-secret": INTERNAL_SECRET }),
    true,
  );
  assert.equal(
    await authorized({ "x-internal-secret": INTERNAL_SECRET }, ""),
    true,
  );
});

test("accepts only the processor's dedicated recovery credential", async () => {
  assert.equal(
    await authorized({
      "x-recovery-secret": COEXISTENCE_RECOVERY_SECRET,
    }),
    true,
  );
  assert.equal(
    await authorized(
      { "x-recovery-secret": OUTBOX_RECOVERY_SECRET },
      OUTBOX_RECOVERY_SECRET,
    ),
    true,
  );
  assert.equal(
    await authorized({ "x-recovery-secret": OUTBOX_RECOVERY_SECRET }),
    false,
  );
  assert.equal(
    await authorized(
      { "x-recovery-secret": COEXISTENCE_RECOVERY_SECRET },
      OUTBOX_RECOVERY_SECRET,
    ),
    false,
  );
});

test("rejects missing, incorrect and partial secrets", async () => {
  assert.equal(await authorized({}), false);
  assert.equal(await authorized({ "x-internal-secret": "incorrect" }), false);
  assert.equal(await authorized({ "x-recovery-secret": "incorrect" }), false);
  assert.equal(
    await authorized({
      "x-recovery-secret": COEXISTENCE_RECOVERY_SECRET.slice(0, -1),
    }),
    false,
  );
});

test("does not accept a valid secret in the other header namespace", async () => {
  assert.equal(
    await authorized({
      "x-internal-secret": COEXISTENCE_RECOVERY_SECRET,
    }),
    false,
  );
  assert.equal(
    await authorized({ "x-recovery-secret": INTERNAL_SECRET }),
    false,
  );
});

test("allows recovery without service-role or an internal secret", async () => {
  assert.equal(
    await authorized(
      { "x-recovery-secret": COEXISTENCE_RECOVERY_SECRET },
      COEXISTENCE_RECOVERY_SECRET,
      "",
    ),
    true,
  );
  assert.equal(
    await authorized(
      { "x-recovery-secret": COEXISTENCE_RECOVERY_SECRET },
      "",
      "",
    ),
    false,
  );
});

test("accepts either valid namespace after evaluating both comparisons", async () => {
  assert.equal(
    await authorized({
      "x-internal-secret": INTERNAL_SECRET,
      "x-recovery-secret": "incorrect",
    }),
    true,
  );
  assert.equal(
    await authorized({
      "x-internal-secret": "incorrect",
      "x-recovery-secret": COEXISTENCE_RECOVERY_SECRET,
    }),
    true,
  );
});
