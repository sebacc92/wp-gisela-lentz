import assert from "node:assert/strict";
import test from "node:test";
import {
  cancelEmbeddedSignupSessionFailClosed,
  embeddedSignupMessageEffect,
  embeddedSignupHandshakeComplete,
  effectiveEmbeddedSignupTokenExpiry,
  embeddedSignupLoginOptions,
  embeddedSignupAccountRequiresResolution,
  embeddedSignupSessionAcceptsCallback,
  embeddedSignupSourceMatchesCapturedPopup,
  embeddedSignupStartAllowed,
  embeddedSignupTabAlreadyAttempted,
  facebookSdkInitialization,
  historySharingDecisionForNewAttempt,
  initialEmbeddedSignupHandshake,
  isTrustedFacebookMessageOrigin,
  onboardingAttemptBlocksStart,
  parseEmbeddedSignupStartConfiguration,
  parseFacebookLoginCode,
  parseWhatsAppEmbeddedSignupMessage,
  reduceEmbeddedSignupHandshake,
  reserveEmbeddedSignupTabAttempt,
  sanitizedEmbeddedSignupSessionEvent,
  WHATSAPP_BUSINESS_APP_FEATURE_TYPE,
  WHATSAPP_BUSINESS_APP_FINISH_EVENT,
  type EmbeddedSignupHandshakeAction,
} from "./whatsapp-embedded-signup.ts";

const trustedOrigin = "https://www.facebook.com";
const sessionPayload = {
  type: "WA_EMBEDDED_SIGNUP",
  event: WHATSAPP_BUSINESS_APP_FINISH_EVENT,
  version: 3,
  data: { waba_id: "123456789012345" },
};

function sessionCandidate() {
  const parsed = parseWhatsAppEmbeddedSignupMessage({
    origin: trustedOrigin,
    data: sessionPayload,
  });
  assert.equal(parsed.accepted, true);
  if (!parsed.accepted || parsed.message.kind !== "session") {
    throw new Error("expected session candidate");
  }
  return parsed.message;
}

test("configura Embedded Signup v4 con la estructura oficial de Coexistence", () => {
  assert.deepEqual(embeddedSignupLoginOptions("987654321098765"), {
    config_id: "987654321098765",
    response_type: "code",
    override_default_response_type: true,
    extras: {
      setup: {},
      featureType: "whatsapp_business_app_onboarding",
      sessionInfoVersion: "3",
    },
  });
  assert.equal(
    "version" in embeddedSignupLoginOptions("987654321098765").extras,
    false,
  );
});

test("rechaza Configuration IDs no numéricos o fuera de rango", () => {
  for (const value of ["", "1234", "config-123", "1".repeat(65)]) {
    assert.throws(
      () => embeddedSignupLoginOptions(value),
      /META_CONFIGURATION_ID_INVALID/,
    );
  }
});

test("inicializa el SDK con App ID validada y Graph v26", () => {
  assert.deepEqual(facebookSdkInitialization("123456789012345"), {
    appId: "123456789012345",
    autoLogAppEvents: true,
    xfbml: true,
    version: "v26.0",
  });
  assert.throws(
    () => facebookSdkInitialization("not-an-app", "v26.0"),
    /META_APP_ID_INVALID/,
  );
  assert.throws(
    () => facebookSdkInitialization("123456789012345", "latest"),
    /META_SDK_VERSION_INVALID/,
  );
});

test("acepta únicamente el origen exacto permitido para el diálogo de Meta", () => {
  assert.equal(
    isTrustedFacebookMessageOrigin("https://www.facebook.com"),
    true,
  );
});

test("rechaza subdominios no listados, sufijos, HTTP, puertos y rutas", () => {
  for (const origin of [
    "https://facebook.com",
    "https://web.facebook.com",
    "https://business.facebook.com",
    "https://nested.business.facebook.com",
    "https://evilfacebook.com",
    "https://facebook.com.evil.example",
    "https://facebook.net",
    "http://www.facebook.com",
    "https://www.facebook.com:444",
    "https://user@www.facebook.com",
    "https://www.facebook.com/path",
    "https://www.facebook.com?next=evil",
    "null",
    "not-a-url",
  ]) {
    assert.equal(isTrustedFacebookMessageOrigin(origin), false, origin);
  }
});

test("acepta SessionInfo con sólo waba_id, sin event/version/phone/business", () => {
  const parsed = parseWhatsAppEmbeddedSignupMessage({
    origin: trustedOrigin,
    data: JSON.stringify({
      type: "WA_EMBEDDED_SIGNUP",
      data: { waba_id: "123456789012345" },
    }),
  });
  assert.equal(parsed.accepted, true);
  if (!parsed.accepted || parsed.message.kind !== "session") return;
  assert.equal(parsed.message.event, null);
  assert.equal(parsed.message.version, null);
  assert.equal(parsed.message.assets.wabaId, "123456789012345");
  assert.equal(parsed.message.assets.phoneNumberId, null);
  assert.equal(parsed.message.assets.businessPortfolioId, null);
});

test("acepta version 3 y eventos desconocidos como metadata no autoritativa", () => {
  for (const payload of [
    sessionPayload,
    { ...sessionPayload, event: "FUTURE_META_COMPLETION" },
    { ...sessionPayload, event: "FINISH" },
    { ...sessionPayload, version: 4 },
  ]) {
    const parsed = parseWhatsAppEmbeddedSignupMessage({
      origin: trustedOrigin,
      data: payload,
    });
    assert.equal(parsed.accepted, true);
    if (!parsed.accepted) return;
    assert.equal(parsed.message.kind, "session");
  }
});

test("phone_number_id y business_id son opcionales y los assets válidos se normalizan", () => {
  const parsed = parseWhatsAppEmbeddedSignupMessage({
    origin: trustedOrigin,
    data: {
      ...sessionPayload,
      data: {
        waba_id: "123456789012345",
        phone_number_id: "234567890123456",
        business_id: "345678901234567",
        waba_ids: ["999999999999999", "123456789012345", "999999999999999"],
        page_ids: ["456789012345678"],
      },
    },
  });
  assert.equal(parsed.accepted, true);
  if (!parsed.accepted || parsed.message.kind !== "session") return;
  assert.equal(parsed.message.assets.phoneNumberId, "234567890123456");
  assert.equal(parsed.message.assets.businessPortfolioId, "345678901234567");
  assert.deepEqual(parsed.message.assets.wabaIds, [
    "123456789012345",
    "999999999999999",
  ]);
});

test("campos opcionales incompatibles no impiden canonicalizar luego con Graph", () => {
  const parsed = parseWhatsAppEmbeddedSignupMessage({
    origin: trustedOrigin,
    data: {
      ...sessionPayload,
      data: {
        waba_id: "123456789012345",
        phone_number_id: 234567890123456,
        business_id: "not-an-id",
        page_ids: ["not-an-id"],
      },
    },
  });
  assert.equal(parsed.accepted, true);
  if (!parsed.accepted || parsed.message.kind !== "session") return;
  assert.equal(parsed.message.assets.phoneNumberId, null);
  assert.equal(parsed.message.assets.businessPortfolioId, null);
  assert.deepEqual(parsed.message.assets.pageIds, []);
});

test("current_step siempre es intermedio, no FINISH ni cancelación", () => {
  for (const currentStep of ["business_selection", null, ""]) {
    const parsed = parseWhatsAppEmbeddedSignupMessage({
      origin: trustedOrigin,
      data: {
        type: "WA_EMBEDDED_SIGNUP",
        event: "CANCEL",
        version: 3,
        data: {
          current_step: currentStep,
          waba_id: "123456789012345",
        },
      },
    });
    assert.equal(parsed.accepted, true);
    if (!parsed.accepted) return;
    assert.equal(parsed.message.kind, "intermediate");
    assert.equal(embeddedSignupMessageEffect(parsed), "intermediate");
  }
});

test("acepta únicamente cancelación y ERROR explícitos sin current_step", () => {
  const cancelled = parseWhatsAppEmbeddedSignupMessage({
    origin: trustedOrigin,
    data: {
      type: "WA_EMBEDDED_SIGNUP",
      event: "CANCEL",
      data: {},
    },
  });
  assert.equal(cancelled.accepted, true);
  if (!cancelled.accepted) return;
  assert.equal(cancelled.message.kind, "cancel");

  const failed = parseWhatsAppEmbeddedSignupMessage({
    origin: trustedOrigin,
    data: {
      type: "WA_EMBEDDED_SIGNUP",
      event: "ERROR",
      version: 4,
      data: { error_code: "ACCESS_DENIED" },
    },
  });
  assert.deepEqual(failed, {
    accepted: true,
    message: {
      kind: "error",
      type: "WA_EMBEDDED_SIGNUP",
      event: "ERROR",
      version: 4,
      errorCode: "ACCESS_DENIED",
    },
  });
});

test("rechaza origen incorrecto y clasifica WA contradictorio sin WABA", () => {
  assert.deepEqual(
    parseWhatsAppEmbeddedSignupMessage({
      origin: "https://evilfacebook.com",
      data: sessionPayload,
    }),
    { accepted: false, reason: "UNTRUSTED_ORIGIN" },
  );
  assert.deepEqual(
    parseWhatsAppEmbeddedSignupMessage({
      origin: trustedOrigin,
      data: "{not-json",
    }),
    { accepted: false, reason: "INVALID_PAYLOAD" },
  );
  const contradictory = parseWhatsAppEmbeddedSignupMessage({
    origin: trustedOrigin,
    data: { type: "WA_EMBEDDED_SIGNUP", data: {} },
  });
  assert.deepEqual(contradictory, {
    accepted: false,
    reason: "CONTRADICTORY_SESSION_INFO",
  });
  assert.equal(embeddedSignupMessageEffect(contradictory), "contradictory");
});

test("postMessage no JSON y JSON no-WA se ignoran sin alterar onboarding", () => {
  const nonJson = parseWhatsAppEmbeddedSignupMessage({
    origin: trustedOrigin,
    data: "{not-json",
  });
  const facebookMessage = parseWhatsAppEmbeddedSignupMessage({
    origin: trustedOrigin,
    data: JSON.stringify({ type: "FB_LOGIN", event: "CLOSE" }),
  });
  assert.equal(embeddedSignupMessageEffect(nonJson), "ignore");
  assert.equal(embeddedSignupMessageEffect(facebookMessage), "ignore");
});

test("FINISH genérico con WABA es candidato y no se eleva a autoridad", () => {
  const parsed = parseWhatsAppEmbeddedSignupMessage({
    origin: trustedOrigin,
    data: {
      type: "WA_EMBEDDED_SIGNUP",
      event: "FINISH",
      version: 3,
      data: { waba_id: "123456789012345" },
    },
  });
  assert.equal(parsed.accepted, true);
  if (!parsed.accepted || parsed.message.kind !== "session") return;
  assert.equal(parsed.message.event, "FINISH");
  assert.equal(embeddedSignupMessageEffect(parsed), "session");
});

test("logging de Session Info conserva sólo metadata sanitizada", () => {
  const summary = sanitizedEmbeddedSignupSessionEvent({
    origin: trustedOrigin,
    sourceMatchesCapturedPopup: false,
    data: JSON.stringify({
      type: "WA_EMBEDDED_SIGNUP",
      event: WHATSAPP_BUSINESS_APP_FINISH_EVENT,
      version: 3,
      data: {
        waba_id: "123456789012345",
        phone_number_id: "234567890123456",
        authorization_code: "must-never-be-logged",
        "invalid key with spaces": "private-value",
      },
    }),
  });
  assert.deepEqual(summary, {
    origin: trustedOrigin,
    dataType: "string",
    type: "WA_EMBEDDED_SIGNUP",
    event: WHATSAPP_BUSINESS_APP_FINISH_EVENT,
    version: 3,
    hasCurrentStep: false,
    hasWabaId: true,
    sourceMatchesCapturedPopup: false,
    dataKeys: ["authorization_code", "phone_number_id", "waba_id"],
  });
  const serialized = JSON.stringify(summary);
  assert.equal(serialized.includes("123456789012345"), false);
  assert.equal(serialized.includes("234567890123456"), false);
  assert.equal(serialized.includes("must-never-be-logged"), false);
  assert.equal(serialized.includes("private-value"), false);
});

test("logging no inspecciona metadata de postMessages ajenos a WhatsApp", () => {
  const summary = sanitizedEmbeddedSignupSessionEvent({
    origin: trustedOrigin,
    data: JSON.stringify({
      type: "FB_LOGIN",
      event: "opaque-personal-value",
      version: "opaque-version",
      data: { "123456789012345": "private", patient_name: "private" },
    }),
  });
  assert.deepEqual(summary, {
    origin: trustedOrigin,
    dataType: "string",
    type: null,
    event: null,
    version: null,
    hasCurrentStep: false,
    hasWabaId: false,
    sourceMatchesCapturedPopup: false,
    dataKeys: [],
  });
});

test("extrae un código opaco no vacío sin normalizarlo", () => {
  assert.equal(
    parseFacebookLoginCode({ authResponse: { code: "one-time-code-value" } }),
    "one-time-code-value",
  );
  assert.equal(
    parseFacebookLoginCode({ authResponse: { code: " short " } }),
    " short ",
  );
  assert.equal(parseFacebookLoginCode({ authResponse: { code: "" } }), null);
  assert.equal(parseFacebookLoginCode({ authResponse: { code: 123 } }), null);
  assert.equal(
    parseFacebookLoginCode({ authResponse: { code: "x".repeat(4_097) } }),
    null,
  );
});

test("popup cerrado o cancelado sin auth code no produce intercambio", () => {
  assert.equal(parseFacebookLoginCode(null), null);
  assert.equal(parseFacebookLoginCode({ status: "unknown" }), null);
  assert.equal(parseFacebookLoginCode({ authResponse: null }), null);
  assert.equal(parseFacebookLoginCode({ authResponse: {} }), null);
});

test("valida configuración pública y transacción efímera del backend", () => {
  const now = Date.parse("2026-08-26T12:00:00Z");
  const parsed = parseEmbeddedSignupStartConfiguration(
    {
      attemptId: "5d5fa81c-b8c0-46cc-8d55-b81e58ed496a",
      state: "state_abcdefghijklmnopqrstuvwxyz012345",
      nonce: "nonce_abcdefghijklmnopqrstuvwxyz012345",
      expiresAt: "2026-08-26T12:10:00Z",
      appId: "123456789012345",
      configurationId: "987654321098765",
      apiVersion: "v26.0",
      sessionInfoVersion: "3",
      featureType: WHATSAPP_BUSINESS_APP_FEATURE_TYPE,
    },
    now,
  );
  assert.equal(parsed?.appId, "123456789012345");
  assert.equal(parsed?.configurationId, "987654321098765");
  assert.equal(parsed?.expiresAt, "2026-08-26T12:10:00.000Z");
});

test("rechaza configuración backend vencida, alterada o demasiado duradera", () => {
  const now = Date.parse("2026-08-26T12:00:00Z");
  const valid = {
    attemptId: "attempt-12345678",
    state: "state_abcdefghijklmnopqrstuvwxyz012345",
    nonce: "nonce_abcdefghijklmnopqrstuvwxyz012345",
    expiresAt: "2026-08-26T12:10:00Z",
    appId: "123456789012345",
    configurationId: "987654321098765",
    sessionInfoVersion: "3",
    featureType: WHATSAPP_BUSINESS_APP_FEATURE_TYPE,
  };
  assert.equal(
    parseEmbeddedSignupStartConfiguration(
      { ...valid, expiresAt: "2026-08-26T11:59:59Z" },
      now,
    ),
    null,
  );
  assert.equal(
    parseEmbeddedSignupStartConfiguration(
      { ...valid, expiresAt: "2026-08-26T13:00:00Z" },
      now,
    ),
    null,
  );
  assert.equal(
    parseEmbeddedSignupStartConfiguration(
      { ...valid, sessionInfoVersion: "2" },
      now,
    ),
    null,
  );
  assert.equal(
    parseEmbeddedSignupStartConfiguration(
      { ...valid, featureType: "other" },
      now,
    ),
    null,
  );
  assert.equal(
    parseEmbeddedSignupStartConfiguration({ ...valid, appId: "secret" }, now),
    null,
  );
});

test("code primero espera SessionInfo y luego emite una sola completion", () => {
  const initial = initialEmbeddedSignupHandshake();
  const code = reduceEmbeddedSignupHandshake(initial, {
    type: "code_received",
    code: "single-use-code-never-store",
  });
  assert.equal(code.state.codeReceived, true);
  assert.deepEqual(code.effects, []);

  const session = sessionCandidate();
  const completion = reduceEmbeddedSignupHandshake(code.state, {
    type: "session_received",
    message: session,
  });
  assert.deepEqual(completion.effects, [
    {
      type: "complete",
      code: "single-use-code-never-store",
      session,
    },
  ]);
  assert.equal(completion.state.authorizationCode, null);
  assert.equal(completion.state.completionDispatched, true);
});

test("SessionInfo primero espera code y luego emite la misma completion", () => {
  const session = sessionCandidate();
  const first = reduceEmbeddedSignupHandshake(
    initialEmbeddedSignupHandshake(),
    { type: "session_received", message: session },
  );
  assert.deepEqual(first.effects, []);

  const second = reduceEmbeddedSignupHandshake(first.state, {
    type: "code_received",
    code: "single-use-code-after-session",
  });
  assert.deepEqual(second.effects, [
    {
      type: "complete",
      code: "single-use-code-after-session",
      session,
    },
  ]);
});

test("callbacks duplicados no sustituyen señales ni vuelven a completar", () => {
  const firstCode = reduceEmbeddedSignupHandshake(
    initialEmbeddedSignupHandshake(),
    { type: "code_received", code: "single-use-code-first" },
  );
  const duplicateCode = reduceEmbeddedSignupHandshake(firstCode.state, {
    type: "code_received",
    code: "different-replayed-code",
  });
  assert.deepEqual(duplicateCode.effects, []);

  const session = sessionCandidate();
  const completed = reduceEmbeddedSignupHandshake(duplicateCode.state, {
    type: "session_received",
    message: session,
  });
  assert.equal(completed.effects.length, 1);
  const duplicateSession = reduceEmbeddedSignupHandshake(completed.state, {
    type: "session_received",
    message: session,
  });
  const replayedCode = reduceEmbeddedSignupHandshake(duplicateSession.state, {
    type: "code_received",
    code: "third-replayed-code",
  });
  assert.deepEqual(duplicateSession.effects, []);
  assert.deepEqual(replayedCode.effects, []);
});

test("el handshake sólo termina tras ACK de la completion combinada", () => {
  const code = reduceEmbeddedSignupHandshake(initialEmbeddedSignupHandshake(), {
    type: "code_received",
    code: "single-use-code",
  }).state;
  assert.equal(embeddedSignupHandshakeComplete(code), false);
  const dispatched = reduceEmbeddedSignupHandshake(code, {
    type: "session_received",
    message: sessionCandidate(),
  }).state;
  assert.equal(embeddedSignupHandshakeComplete(dispatched), false);
  const acknowledged = reduceEmbeddedSignupHandshake(dispatched, {
    type: "completion_acknowledged",
  }).state;
  assert.equal(embeddedSignupHandshakeComplete(acknowledged), true);
});

test("un intento activo o incompleto bloquea otro onboarding", () => {
  assert.equal(onboardingAttemptBlocksStart(null), false);
  assert.equal(
    onboardingAttemptBlocksStart({ attemptId: "attempt-1", state: "started" }),
    true,
  );
  assert.equal(
    onboardingAttemptBlocksStart({ attemptId: "attempt-1", state: "failed" }),
    false,
  );
  assert.equal(
    onboardingAttemptBlocksStart({ attemptId: "attempt-1", state: "expired" }),
    false,
  );
  assert.equal(
    onboardingAttemptBlocksStart({
      attemptId: "attempt-1",
      state: "cancelled",
    }),
    false,
  );
  assert.equal(
    onboardingAttemptBlocksStart({
      attemptId: "attempt-1",
      state: "completed",
    }),
    false,
  );
});

test("reload conserva el tombstone y bloquea otro Embedded Signup en la pestaña", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };

  assert.equal(embeddedSignupTabAlreadyAttempted(storage), false);
  assert.equal(reserveEmbeddedSignupTabAttempt(storage), true);
  assert.equal(embeddedSignupTabAlreadyAttempted(storage), true);
  // Una recarga crea otra instancia de UI pero conserva sessionStorage.
  assert.equal(reserveEmbeddedSignupTabAttempt(storage), false);
  assert.deepEqual([...values.values()], ["used"]);
});

test("event.source distinto es telemetría y no invalida candidato con origen exacto", () => {
  const firstTabValues = new Map<string, string>();
  const secondTabValues = new Map<string, string>();
  const firstTab = {
    getItem: (key: string) => firstTabValues.get(key) ?? null,
    setItem: (key: string, value: string) => firstTabValues.set(key, value),
  };
  const secondTab = {
    getItem: (key: string) => secondTabValues.get(key) ?? null,
    setItem: (key: string, value: string) => secondTabValues.set(key, value),
  };
  assert.equal(reserveEmbeddedSignupTabAttempt(firstTab), true);
  assert.equal(embeddedSignupTabAlreadyAttempted(secondTab), false);

  const expectedPopup = {};
  const otherTabPopup = {};
  assert.equal(
    embeddedSignupSourceMatchesCapturedPopup(expectedPopup, otherTabPopup),
    false,
  );
  assert.equal(
    embeddedSignupSourceMatchesCapturedPopup(expectedPopup, null),
    false,
  );
  assert.equal(
    embeddedSignupSourceMatchesCapturedPopup(expectedPopup, expectedPopup),
    true,
  );
  const parsed = parseWhatsAppEmbeddedSignupMessage({
    origin: trustedOrigin,
    data: sessionPayload,
  });
  assert.equal(parsed.accepted, true);
});

test("feature flag apagado bloquea antes de reservar pestaña o cargar el SDK", () => {
  const otherwiseReady = {
    isAdmin: true,
    enabled: true,
    configured: true,
    actionInProgress: false,
    tabAttemptLocked: false,
    connected: false,
    partialAccount: false,
    automationsEnabled: false,
    blockingAttempt: false,
  };
  assert.equal(embeddedSignupStartAllowed(otherwiseReady), true);
  assert.equal(
    embeddedSignupStartAllowed({ ...otherwiseReady, enabled: false }),
    false,
  );
  assert.equal(
    embeddedSignupStartAllowed({ ...otherwiseReady, configured: false }),
    false,
  );
});

test("usa data_access_expires_at como vencimiento efectivo cuando es el único límite", () => {
  assert.equal(
    effectiveEmbeddedSignupTokenExpiry({
      tokenExpiresAt: null,
      tokenDataAccessExpiresAt: "2026-09-30T12:00:00Z",
    }),
    "2026-09-30T12:00:00.000Z",
  );
  assert.equal(
    effectiveEmbeddedSignupTokenExpiry({
      tokenExpiresAt: "not-a-date",
      tokenDataAccessExpiresAt: "2026-09-30T12:00:00Z",
    }),
    "2026-09-30T12:00:00.000Z",
  );
});

test("elige el vencimiento válido más temprano sin propagar valores inválidos", () => {
  assert.equal(
    effectiveEmbeddedSignupTokenExpiry({
      tokenExpiresAt: "2026-10-30T12:00:00Z",
      tokenDataAccessExpiresAt: "2026-09-30T12:00:00Z",
    }),
    "2026-09-30T12:00:00.000Z",
  );
  assert.equal(
    effectiveEmbeddedSignupTokenExpiry({
      tokenExpiresAt: "invalid",
      tokenDataAccessExpiresAt: { secret: "must-not-cross-ui-boundary" },
    }),
    "",
  );
});

test("callbacks vencidos, cancelados o posteriores a offboarding fallan cerrado", () => {
  const now = Date.parse("2026-08-26T12:00:00Z");
  const active = {
    activeSessionMatches: true,
    closing: false,
    expiresAtMs: now + 60_000,
    now,
    sessionLifecycleState: "active",
  };
  assert.equal(embeddedSignupSessionAcceptsCallback(active), true);
  assert.equal(
    embeddedSignupSessionAcceptsCallback({
      ...active,
      activeSessionMatches: false,
    }),
    false,
    "callback tras release/cancelación",
  );
  assert.equal(
    embeddedSignupSessionAcceptsCallback({ ...active, closing: true }),
    false,
    "callback mientras la cancelación está en curso",
  );
  assert.equal(
    embeddedSignupSessionAcceptsCallback({ ...active, expiresAtMs: now }),
    false,
    "intento vencido",
  );
  for (const sessionLifecycleState of ["cancelling", "offboarding"]) {
    assert.equal(
      embeddedSignupSessionAcceptsCallback({
        ...active,
        sessionLifecycleState,
      }),
      false,
      sessionLifecycleState,
    );
  }
});

test("un callback tardío dentro del límite server-side sigue correlacionado", () => {
  const startedAt = Date.parse("2026-08-26T12:00:00Z");
  assert.equal(
    embeddedSignupSessionAcceptsCallback({
      activeSessionMatches: true,
      closing: false,
      expiresAtMs: startedAt + 10 * 60_000,
      now: startedAt + 4 * 60_000 + 30_000,
      sessionLifecycleState: "active",
    }),
    true,
  );
});

test("cancelación fallida libera la sesión y vuelve inertes código y FINISH tardíos", async () => {
  const now = Date.parse("2026-08-26T12:00:00Z");
  const session = {
    closing: false,
    lifecycleState: "active" as const,
    expiresAtMs: now + 60_000,
    handshake: initialEmbeddedSignupHandshake(),
  };
  let active = true;
  let released = 0;
  let reconciled = 0;
  let completionCalls = 0;
  let graphCalls = 0;
  let rejectCancellation!: (error: Error) => void;
  const cancellationRpc = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });

  const lateCallback = (action: EmbeddedSignupHandshakeAction) => {
    if (
      !embeddedSignupSessionAcceptsCallback({
        activeSessionMatches: active,
        closing: session.closing,
        expiresAtMs: session.expiresAtMs,
        now,
        sessionLifecycleState: session.lifecycleState,
      })
    ) {
      return;
    }
    const transition = reduceEmbeddedSignupHandshake(session.handshake, action);
    session.handshake = transition.state;
    for (const _effect of transition.effects) {
      completionCalls += 1;
      graphCalls += 1;
    }
  };

  const cancellation = cancelEmbeddedSignupSessionFailClosed({
    session,
    releaseSession: () => {
      released += 1;
      active = false;
    },
    requestCancellation: () => cancellationRpc,
    reconcileStatus: () => {
      reconciled += 1;
    },
  });
  await Promise.resolve();

  lateCallback({ type: "code_received", code: "late-code-during-cancel" });
  lateCallback({ type: "session_received", message: sessionCandidate() });
  rejectCancellation(new Error("network unavailable"));
  const result = await cancellation;
  lateCallback({ type: "code_received", code: "late-code-after-failure" });
  lateCallback({ type: "session_received", message: sessionCandidate() });

  assert.deepEqual(result, {
    outcome: "request_failed",
    released: true,
    reconciled: true,
  });
  assert.equal(session.closing, true);
  assert.equal(session.lifecycleState, "cancelling");
  assert.equal(active, false);
  assert.equal(released, 1);
  assert.equal(reconciled, 1);
  assert.equal(completionCalls, 0);
  assert.equal(graphCalls, 0);
});

test("cancelled false reconcilia la finalización concurrente sin éxito falso", async () => {
  const now = Date.parse("2026-08-26T12:00:00Z");
  const session = {
    closing: false,
    lifecycleState: "active" as const,
    expiresAtMs: now + 60_000,
  };
  let active = true;
  let observedStatus = "started";
  let exchangeCalls = 0;
  let finishCalls = 0;

  const result = await cancelEmbeddedSignupSessionFailClosed({
    session,
    releaseSession: () => {
      active = false;
    },
    requestCancellation: async () => ({ cancelled: false }),
    reconcileStatus: () => {
      observedStatus = "completed";
    },
  });
  const acceptsLateCallback = embeddedSignupSessionAcceptsCallback({
    activeSessionMatches: active,
    closing: session.closing,
    expiresAtMs: session.expiresAtMs,
    now,
    sessionLifecycleState: session.lifecycleState,
  });
  if (acceptsLateCallback) {
    exchangeCalls += 1;
    finishCalls += 1;
  }

  assert.deepEqual(result, {
    outcome: "not_cancelled",
    released: true,
    reconciled: true,
  });
  assert.equal(observedStatus, "completed");
  assert.equal(session.closing, true);
  assert.equal(session.lifecycleState, "cancelling");
  assert.equal(exchangeCalls, 0);
  assert.equal(finishCalls, 0);
});

test("falla cerrado si el storage tab-scoped no está disponible", () => {
  const unavailable = {
    getItem: (_key: string): string | null => {
      throw new Error("storage disabled");
    },
    setItem: (_key: string, _value: string) => {
      throw new Error("storage disabled");
    },
  };

  assert.equal(embeddedSignupTabAlreadyAttempted(unavailable), true);
  assert.equal(reserveEmbeddedSignupTabAttempt(unavailable), false);
});

test("cada onboarding requiere una nueva decisión explícita de history", () => {
  assert.equal(historySharingDecisionForNewAttempt(false), "declined");
  assert.equal(historySharingDecisionForNewAttempt(true), "accepted");
});

test("una credencial vencida y fallida exige offboarding, no otro start", () => {
  assert.equal(
    embeddedSignupAccountRequiresResolution({
      hasAccount: true,
      requiresOffboarding: true,
      tokenConfigured: false,
      onboardingStatus: "failed",
    }),
    true,
  );
  assert.equal(
    embeddedSignupAccountRequiresResolution({
      hasAccount: true,
      requiresOffboarding: false,
      tokenConfigured: false,
      onboardingStatus: "offboarded",
    }),
    false,
  );
});
