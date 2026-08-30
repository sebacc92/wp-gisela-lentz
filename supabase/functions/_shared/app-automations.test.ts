import assert from "node:assert/strict";
import test from "node:test";
import { appAutomationsEnabled } from "./app-automations.ts";

test("app automations require an explicit enabled setting", () => {
  assert.equal(appAutomationsEnabled({ automations_enabled: true }), true);
  assert.equal(appAutomationsEnabled({ automations_enabled: false }), false);
  assert.equal(appAutomationsEnabled({}), false);
  assert.equal(appAutomationsEnabled(null), false);
  assert.equal(appAutomationsEnabled("true"), false);
});
