export interface ConversationAutomationTestState {
  conversationId: string;
  globalAutomationsEnabled: boolean;
  testOverrideActive: boolean;
  testOverrideActivatedAt: string | null;
  testOverrideUntil: string | null;
  effectiveOperationalEnabled: boolean;
  effectiveAutomationEnabled: boolean;
  automationMode: "auto" | "manual";
  needsHuman: boolean;
  conversationStatus: "open" | "closed";
}

export interface ConversationAutomationDisplayState {
  globalLabel: "Activo" | "Apagado" | "No disponible";
  chatLabel:
    | "Activo por el bot global"
    | "Activo para pruebas"
    | "En pausa manual"
    | "Requiere atención humana"
    | "Conversación cerrada"
    | "Apagado"
    | "No disponible";
  overrideActive: boolean;
  effectiveForChat: boolean;
}

interface ConversationAutomationStateRow {
  conversation_id?: unknown;
  global_automations_enabled?: unknown;
  test_override_active?: unknown;
  test_override_activated_at?: unknown;
  test_override_until?: unknown;
  effective_operational_enabled?: unknown;
  effective_automation_enabled?: unknown;
  automation_mode?: unknown;
  needs_human?: unknown;
  conversation_status?: unknown;
}

function nullableIso(value: unknown): string | null {
  return typeof value === "string" && !Number.isNaN(Date.parse(value))
    ? value
    : null;
}

export function conversationAutomationTestStateFromRpc(
  value: unknown,
): ConversationAutomationTestState | null {
  const row = (
    Array.isArray(value) ? value[0] : value
  ) as ConversationAutomationStateRow | null;
  if (!row || typeof row !== "object") return null;
  if (typeof row.conversation_id !== "string") return null;
  if (typeof row.global_automations_enabled !== "boolean") return null;
  if (typeof row.test_override_active !== "boolean") return null;
  if (typeof row.effective_operational_enabled !== "boolean") return null;
  if (typeof row.effective_automation_enabled !== "boolean") return null;
  if (row.automation_mode !== "auto" && row.automation_mode !== "manual") {
    return null;
  }
  if (typeof row.needs_human !== "boolean") return null;
  if (
    row.conversation_status !== "open" &&
    row.conversation_status !== "closed"
  ) {
    return null;
  }

  return {
    conversationId: row.conversation_id,
    globalAutomationsEnabled: row.global_automations_enabled,
    testOverrideActive: row.test_override_active,
    testOverrideActivatedAt: nullableIso(row.test_override_activated_at),
    testOverrideUntil: nullableIso(row.test_override_until),
    effectiveOperationalEnabled: row.effective_operational_enabled,
    effectiveAutomationEnabled: row.effective_automation_enabled,
    automationMode: row.automation_mode,
    needsHuman: row.needs_human,
    conversationStatus: row.conversation_status,
  };
}

export function conversationTestOverrideIsActive(
  state: ConversationAutomationTestState,
  nowMs = Date.now(),
): boolean {
  if (!state.testOverrideActive || !state.testOverrideUntil) return false;
  return new Date(state.testOverrideUntil).getTime() > nowMs;
}

export function conversationAutomationDisplayState(
  state: ConversationAutomationTestState | null,
  globalFallback: boolean | null,
  nowMs = Date.now(),
): ConversationAutomationDisplayState {
  if (!state) {
    return {
      globalLabel:
        globalFallback === null
          ? "No disponible"
          : globalFallback
            ? "Activo"
            : "Apagado",
      chatLabel: "No disponible",
      overrideActive: false,
      effectiveForChat: false,
    };
  }

  const globalEnabled = globalFallback ?? state.globalAutomationsEnabled;
  const overrideActive = conversationTestOverrideIsActive(state, nowMs);
  const operationallyEnabled = globalEnabled || overrideActive;

  if (state.conversationStatus !== "open") {
    return {
      globalLabel: globalEnabled ? "Activo" : "Apagado",
      chatLabel: "Conversación cerrada",
      overrideActive,
      effectiveForChat: false,
    };
  }
  if (state.automationMode === "manual") {
    return {
      globalLabel: globalEnabled ? "Activo" : "Apagado",
      chatLabel: "En pausa manual",
      overrideActive,
      effectiveForChat: false,
    };
  }
  if (state.needsHuman) {
    return {
      globalLabel: globalEnabled ? "Activo" : "Apagado",
      chatLabel: "Requiere atención humana",
      overrideActive,
      effectiveForChat: false,
    };
  }
  if (globalEnabled) {
    return {
      globalLabel: "Activo",
      chatLabel: "Activo por el bot global",
      overrideActive,
      effectiveForChat: true,
    };
  }
  if (overrideActive && operationallyEnabled) {
    return {
      globalLabel: "Apagado",
      chatLabel: "Activo para pruebas",
      overrideActive: true,
      effectiveForChat: true,
    };
  }
  return {
    globalLabel: "Apagado",
    chatLabel: "Apagado",
    overrideActive: false,
    effectiveForChat: false,
  };
}

export function formatConversationTestOverrideUntil(
  value: string,
  locale = "es-AR",
): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "America/Argentina/Buenos_Aires",
  }).format(new Date(value));
}
