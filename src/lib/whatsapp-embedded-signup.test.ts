import assert from "node:assert/strict";
import test from "node:test";
import {
  bindEmbeddedSignupMessageSource,
  cancelEmbeddedSignupSessionFailClosed,
  embeddedSignupHandshakeComplete,
  effectiveEmbeddedSignupTokenExpiry,
  embeddedSignupLoginOptions,
  embeddedSignupAccountRequiresResolution,
  embeddedSignupSessionAcceptsCallback,
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
  WHATSAPP_BUSINESS_APP_FEATURE_TYPE,
  WHATSAPP_BUSINESS_APP_FINISH_EVENT,
  type EmbeddedSignupHandshakeAction,
} from "./whatsapp-embedded-signup.ts";

const trustedOrigin = "https://www.facebook.com";
const finishPayload = {
  type: "WA_EMBEDDED_SIGNUP",
  event: WHATSAPP_BUSINESS_APP_FINISH_EVENT,
  version: 3,
  data: { waba_id: "123456789012345" },
};

function finishMessage() {
  const parsed = parseWhatsAppEmbeddedSignupMessage({
    origin: trustedOrigin,
    data: finishPayload,
  });
  assert.equal(parsed.accepted, true);
  if (!parsed.accepted || parsed.message.kind !== "finish") {
    throw new Error("expected finish message");
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

test("parsea FINISH Coexistence oficial con sólo waba_id", () => {
  const parsed = parseWhatsAppEmbeddedSignupMessage({
    origin: trustedOrigin,
    data: JSON.stringify(finishPayload),
  });
  assert.equal(parsed.accepted, true);
  if (!parsed.accepted || parsed.message.kind !== "finish") return;
  assert.equal(parsed.message.assets.wabaId, "123456789012345");
  assert.equal(parsed.message.assets.phoneNumberId, null);
  assert.equal(parsed.message.assets.businessPortfolioId, null);
  assert.deepEqual(parsed.message.assets.wabaIds, []);
});

test("parsea el objeto FINISH genérico y normaliza listas de assets", () => {
  const parsed = parseWhatsAppEmbeddedSignupMessage({
    origin: trustedOrigin,
    data: {
      ...finishPayload,
      data: {
        waba_id: "123456789012345",
        phone_number_id: "234567890123456",
        business_id: "345678901234567",
        waba_ids: ["999999999999999", "123456789012345", "999999999999999"],
        page_ids: ["456789012345678"],
        ad_account_ids: [],
        dataset_ids: [],
        catalog_ids: [],
        instagram_account_ids: [],
      },
    },
  });
  assert.equal(parsed.accepted, true);
  if (!parsed.accepted || parsed.message.kind !== "finish") return;
  assert.equal(parsed.message.assets.phoneNumberId, "234567890123456");
  assert.equal(parsed.message.assets.businessPortfolioId, "345678901234567");
  assert.deepEqual(parsed.message.assets.wabaIds, [
    "123456789012345",
    "999999999999999",
  ]);
  assert.deepEqual(parsed.message.assets.pageIds, ["456789012345678"]);
});

test("rechaza FINISH sin WABA o con IDs que perderían precisión", () => {
  const invalidData = [
    {},
    { waba_id: 123456789012345 },
    { waba_id: "abc" },
    { waba_id: "123456789012345", phone_number_id: 234567890123456 },
    { waba_id: "123456789012345", page_ids: ["bad-id"] },
    {
      waba_id: "123456789012345",
      waba_ids: ["999999999999999"],
    },
    {
      waba_id: "123456789012345",
      page_ids: Array.from({ length: 101 }, (_, index) =>
        String(10000 + index),
      ),
    },
  ];
  for (const data of invalidData) {
    const parsed = parseWhatsAppEmbeddedSignupMessage({
      origin: trustedOrigin,
      data: { ...finishPayload, data },
    });
    assert.deepEqual(parsed, { accepted: false, reason: "INVALID_ASSETS" });
  }
});

test("parsea cancelación simple y cancelación con error sin retener el mensaje", () => {
  const cancelled = parseWhatsAppEmbeddedSignupMessage({
    origin: trustedOrigin,
    data: {
      type: "WA_EMBEDDED_SIGNUP",
      event: "CANCEL",
      version: 3,
      data: { current_step: "business_selection" },
    },
  });
  assert.deepEqual(cancelled, {
    accepted: true,
    message: {
      kind: "cancel",
      type: "WA_EMBEDDED_SIGNUP",
      event: "CANCEL",
      version: 3,
      currentStep: "business_selection",
      errorCode: null,
      hasError: false,
    },
  });

  const failed = parseWhatsAppEmbeddedSignupMessage({
    origin: trustedOrigin,
    data: JSON.stringify({
      type: "WA_EMBEDDED_SIGNUP",
      event: "CANCEL",
      version: 3,
      data: {
        error_code: "ACCESS_DENIED",
        error_message: "provider detail that must not be retained",
        session_id: "provider-session",
        timestamp: "2026-08-26T12:00:00Z",
      },
    }),
  });
  assert.equal(failed.accepted, true);
  if (!failed.accepted || failed.message.kind !== "cancel") return;
  assert.equal(failed.message.errorCode, "ACCESS_DENIED");
  assert.equal(failed.message.hasError, true);
  assert.equal(JSON.stringify(failed).includes("provider detail"), false);
  assert.equal(JSON.stringify(failed).includes("provider-session"), false);
});

test("acepta CANCEL y ERROR oficiales sin version, pero rechaza otra version", () => {
  const cancelled = parseWhatsAppEmbeddedSignupMessage({
    origin: trustedOrigin,
    data: {
      type: "WA_EMBEDDED_SIGNUP",
      event: "CANCEL",
      data: { current_step: "phone_number_setup" },
    },
  });
  assert.equal(cancelled.accepted, true);
  if (!cancelled.accepted || cancelled.message.kind !== "cancel") return;
  assert.equal(cancelled.message.version, 3);
  assert.equal(cancelled.message.currentStep, "phone_number_setup");

  const failed = parseWhatsAppEmbeddedSignupMessage({
    origin: trustedOrigin,
    data: {
      type: "WA_EMBEDDED_SIGNUP",
      event: "ERROR",
      data: { error_code: "ACCESS_DENIED" },
    },
  });
  assert.equal(failed.accepted, true);

  for (const event of ["CANCEL", "ERROR"]) {
    assert.deepEqual(
      parseWhatsAppEmbeddedSignupMessage({
        origin: trustedOrigin,
        data: {
          type: "WA_EMBEDDED_SIGNUP",
          event,
          version: 2,
          data: {},
        },
      }),
      { accepted: false, reason: "UNSUPPORTED_VERSION" },
    );
  }
});

test("parsea ERROR sanitizado", () => {
  const parsed = parseWhatsAppEmbeddedSignupMessage({
    origin: trustedOrigin,
    data: {
      type: "WA_EMBEDDED_SIGNUP",
      event: "ERROR",
      version: 3,
      data: { error_code: "EMBEDDED_SIGNUP_FAILED" },
    },
  });
  assert.deepEqual(parsed, {
    accepted: true,
    message: {
      kind: "error",
      type: "WA_EMBEDDED_SIGNUP",
      event: "ERROR",
      version: 3,
      errorCode: "EMBEDDED_SIGNUP_FAILED",
    },
  });
});

test("rechaza origen, JSON, tipo, versión y evento inesperados", () => {
  assert.deepEqual(
    parseWhatsAppEmbeddedSignupMessage({
      origin: "https://evilfacebook.com",
      data: finishPayload,
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
  assert.deepEqual(
    parseWhatsAppEmbeddedSignupMessage({
      origin: trustedOrigin,
      data: { ...finishPayload, type: "OTHER" },
    }),
    { accepted: false, reason: "UNRELATED_MESSAGE" },
  );
  assert.deepEqual(
    parseWhatsAppEmbeddedSignupMessage({
      origin: trustedOrigin,
      data: { ...finishPayload, version: "3" },
    }),
    { accepted: false, reason: "UNSUPPORTED_VERSION" },
  );
  assert.deepEqual(
    parseWhatsAppEmbeddedSignupMessage({
      origin: trustedOrigin,
      data: { ...finishPayload, event: "COMPLETE" },
    }),
    { accepted: false, reason: "UNEXPECTED_EVENT" },
  );
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

test("el código dispara exchange inmediatamente y nunca queda en el estado", () => {
  const initial = initialEmbeddedSignupHandshake();
  const transition = reduceEmbeddedSignupHandshake(initial, {
    type: "code_received",
    code: "single-use-code-never-store",
  });
  assert.equal(transition.state.codeDispatched, true);
  assert.equal(transition.effects[0]?.type, "exchange");
  assert.equal(
    transition.effects[0]?.type === "exchange"
      ? transition.effects[0].code
      : null,
    "single-use-code-never-store",
  );
  assert.equal(JSON.stringify(transition.state).includes("never-store"), false);
});

test("si FINISH llega primero, exchange recibe los assets cuando llega el código", () => {
  const finish = finishMessage();
  const first = reduceEmbeddedSignupHandshake(
    initialEmbeddedSignupHandshake(),
    { type: "finish_received", message: finish },
  );
  assert.deepEqual(first.effects, [{ type: "finish", message: finish }]);

  const second = reduceEmbeddedSignupHandshake(first.state, {
    type: "code_received",
    code: "single-use-code-after-finish",
  });
  assert.equal(second.effects[0]?.type, "exchange");
  if (second.effects[0]?.type !== "exchange") return;
  assert.equal(second.effects[0].finish?.assets.wabaId, "123456789012345");
});

test("si el código llega primero, FINISH se entrega aparte sin repetir exchange", () => {
  const code = reduceEmbeddedSignupHandshake(initialEmbeddedSignupHandshake(), {
    type: "code_received",
    code: "single-use-code-first",
  });
  const finish = finishMessage();
  const completed = reduceEmbeddedSignupHandshake(code.state, {
    type: "finish_received",
    message: finish,
  });
  assert.deepEqual(completed.effects, [{ type: "finish", message: finish }]);
  assert.equal(completed.state.codeDispatched, true);
});

test("callbacks duplicados no vuelven a despachar código ni FINISH", () => {
  const firstCode = reduceEmbeddedSignupHandshake(
    initialEmbeddedSignupHandshake(),
    { type: "code_received", code: "single-use-code-first" },
  );
  const duplicateCode = reduceEmbeddedSignupHandshake(firstCode.state, {
    type: "code_received",
    code: "different-replayed-code",
  });
  assert.deepEqual(duplicateCode.effects, []);

  const finish = finishMessage();
  const firstFinish = reduceEmbeddedSignupHandshake(duplicateCode.state, {
    type: "finish_received",
    message: finish,
  });
  const duplicateFinish = reduceEmbeddedSignupHandshake(firstFinish.state, {
    type: "finish_received",
    message: finish,
  });
  assert.deepEqual(duplicateFinish.effects, []);
});

test("el handshake sólo termina tras ACK de exchange y FINISH", () => {
  const initial = initialEmbeddedSignupHandshake();
  const exchanged = reduceEmbeddedSignupHandshake(initial, {
    type: "exchange_acknowledged",
  }).state;
  assert.equal(embeddedSignupHandshakeComplete(exchanged), false);
  const finished = reduceEmbeddedSignupHandshake(exchanged, {
    type: "finish_acknowledged",
  }).state;
  assert.equal(embeddedSignupHandshakeComplete(finished), true);
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

test("otra pestaña tiene tombstone propio pero no puede suplantar event.source", () => {
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
  assert.deepEqual(bindEmbeddedSignupMessageSource(null, expectedPopup), {
    accepted: true,
    source: expectedPopup,
  });
  assert.deepEqual(
    bindEmbeddedSignupMessageSource(expectedPopup, otherTabPopup),
    {
      accepted: false,
      source: expectedPopup,
      reason: "UNEXPECTED_SOURCE",
    },
  );
  assert.deepEqual(bindEmbeddedSignupMessageSource(expectedPopup, null), {
    accepted: false,
    source: expectedPopup,
    reason: "MISSING_SOURCE",
  });
  assert.deepEqual(
    bindEmbeddedSignupMessageSource(expectedPopup, expectedPopup),
    {
      accepted: true,
      source: expectedPopup,
    },
  );
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
  let exchangeCalls = 0;
  let finishCalls = 0;
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
    for (const effect of transition.effects) {
      if (effect.type === "exchange") {
        exchangeCalls += 1;
        graphCalls += 1;
      } else {
        finishCalls += 1;
        graphCalls += 1;
      }
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
  lateCallback({ type: "finish_received", message: finishMessage() });
  rejectCancellation(new Error("network unavailable"));
  const result = await cancellation;
  lateCallback({ type: "code_received", code: "late-code-after-failure" });
  lateCallback({ type: "finish_received", message: finishMessage() });

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
  assert.equal(exchangeCalls, 0);
  assert.equal(finishCalls, 0);
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
