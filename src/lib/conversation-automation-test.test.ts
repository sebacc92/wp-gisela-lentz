import assert from "node:assert/strict";
import test from "node:test";
import {
  conversationAutomationDisplayState,
  conversationAutomationTestStateFromRpc,
  conversationTestOverrideIsActive,
  type ConversationAutomationTestState,
} from "./conversation-automation-test.ts";

const now = Date.parse("2026-09-01T15:00:00Z");

function state(
  overrides: Partial<ConversationAutomationTestState> = {},
): ConversationAutomationTestState {
  return {
    conversationId: "00000000-0000-4000-8000-000000000001",
    globalAutomationsEnabled: false,
    testOverrideActive: false,
    testOverrideActivatedAt: null,
    testOverrideUntil: null,
    effectiveOperationalEnabled: false,
    effectiveAutomationEnabled: false,
    automationMode: "auto",
    needsHuman: false,
    conversationStatus: "open",
    ...overrides,
  };
}

test("global apagado y override apagado muestran el chat apagado", () => {
  const display = conversationAutomationDisplayState(state(), false, now);
  assert.equal(display.globalLabel, "Apagado");
  assert.equal(display.chatLabel, "Apagado");
  assert.equal(display.effectiveForChat, false);
});

test("un override vigente habilita solamente el estado de prueba", () => {
  const enabled = state({
    testOverrideActive: true,
    testOverrideUntil: "2026-09-02T15:00:00Z",
    effectiveOperationalEnabled: true,
    effectiveAutomationEnabled: true,
  });
  const display = conversationAutomationDisplayState(enabled, false, now);
  assert.equal(display.globalLabel, "Apagado");
  assert.equal(display.chatLabel, "Activo para pruebas");
  assert.equal(display.overrideActive, true);
  assert.equal(display.effectiveForChat, true);
});

test("con el switch global activo no atribuye el estado al override", () => {
  const globallyEnabled = state({
    globalAutomationsEnabled: true,
    testOverrideActive: true,
    testOverrideUntil: "2026-09-02T15:00:00Z",
    effectiveOperationalEnabled: true,
    effectiveAutomationEnabled: true,
  });
  const display = conversationAutomationDisplayState(
    globallyEnabled,
    true,
    now,
  );
  assert.equal(display.globalLabel, "Activo");
  assert.equal(display.chatLabel, "Activo por el bot global");
  assert.equal(display.overrideActive, true);
  assert.equal(display.effectiveForChat, true);
});

test("la expiración local deja de mostrar el override como activo", () => {
  const expired = state({
    testOverrideActive: true,
    testOverrideUntil: "2026-09-01T14:59:59Z",
    effectiveOperationalEnabled: true,
    effectiveAutomationEnabled: true,
  });
  assert.equal(conversationTestOverrideIsActive(expired, now), false);
  assert.equal(
    conversationAutomationDisplayState(expired, false, now).chatLabel,
    "Apagado",
  );
});

test("el modo manual domina aun con override o switch global", () => {
  const manual = state({
    globalAutomationsEnabled: true,
    testOverrideActive: true,
    testOverrideUntil: "2026-09-02T15:00:00Z",
    effectiveOperationalEnabled: true,
    effectiveAutomationEnabled: false,
    automationMode: "manual",
  });
  const display = conversationAutomationDisplayState(manual, true, now);
  assert.equal(display.globalLabel, "Activo");
  assert.equal(display.chatLabel, "En pausa manual");
  assert.equal(display.overrideActive, true);
  assert.equal(display.effectiveForChat, false);
});

test("un chat cerrado domina el permiso operativo", () => {
  const closed = state({
    testOverrideActive: true,
    testOverrideUntil: "2026-09-02T15:00:00Z",
    effectiveOperationalEnabled: true,
    effectiveAutomationEnabled: false,
    conversationStatus: "closed",
  });
  assert.equal(
    conversationAutomationDisplayState(closed, false, now).chatLabel,
    "Conversación cerrada",
  );
});

test("normaliza el contrato tabular del RPC", () => {
  const parsed = conversationAutomationTestStateFromRpc([
    {
      conversation_id: "00000000-0000-4000-8000-000000000001",
      global_automations_enabled: false,
      test_override_active: true,
      test_override_activated_at: "2026-09-01T15:00:00Z",
      test_override_until: "2026-09-02T15:00:00Z",
      effective_operational_enabled: true,
      effective_automation_enabled: true,
      automation_mode: "auto",
      needs_human: false,
      conversation_status: "open",
    },
  ]);
  assert.equal(parsed?.testOverrideActive, true);
  assert.equal(parsed?.automationMode, "auto");
});
