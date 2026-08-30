import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

test("el worker respeta el switch persistido antes de procesar mensajes", () => {
  const worker = readFileSync(
    resolve(process.cwd(), "supabase/functions/whatsapp-automation/index.ts"),
    "utf8",
  );
  const snapshot = worker.indexOf(
    "const appSettings = execution.settings_snapshot;",
  );
  const guard = worker.indexOf(
    "if (!appAutomationsEnabled(appSettings))",
    snapshot,
  );
  const disabled = worker.indexOf('reason: "AUTOMATIONS_DISABLED"', guard);
  const serverGuard = worker.indexOf(
    "if (!whatsappAutomationsEnabled())",
    disabled,
  );
  const recipient = worker.indexOf("const automationRecipient", serverGuard);

  assert.ok(snapshot >= 0, "the claimed execution must expose its settings");
  assert.ok(guard > snapshot, "the database switch must guard the worker");
  assert.ok(disabled > guard, "the disabled outcome must be persisted");
  assert.ok(
    serverGuard > disabled,
    "the server kill switch must remain active",
  );
  assert.ok(recipient > serverGuard, "both guards must run before a recipient");
});
