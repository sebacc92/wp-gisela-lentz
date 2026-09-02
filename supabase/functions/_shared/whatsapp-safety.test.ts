import assert from "node:assert/strict";
import test from "node:test";

import {
  assertWhatsAppLocationSnapshot,
  assertWhatsAppRecipientSnapshot,
  existingWhatsAppDispatchDisposition,
  isAutomaticWhatsAppSource,
  isCausallyOwnedManualAutomationNotice,
  isCurrentDepositProofAcknowledgement,
  isOperatorWhatsAppPurpose,
  isRetryableWhatsAppAutomationFailure,
  isWhatsAppTestRecipientAllowed,
  locationPayload,
  normalizeWhatsAppNumber,
  operatorSourceForPurpose,
  parseSafetyBoolean,
  parseWhatsAppAllowedNumbers,
  requiresWhatsAppAutomationExecutionLease,
  resolveWhatsAppRecipientIdentity,
  WhatsAppPolicyError,
  whatsAppPolicyCode,
  whatsappRecipient,
  whatsappRecipientFingerprint,
  whatsappRecipientIdentity,
} from "./whatsapp.ts";
import {
  type WhatsAppAccountCredentials,
  WhatsAppCredentialResolutionError,
} from "./whatsapp-account-credentials.ts";

test("usa el wa_id telefónico observado antes que un BSUID cuando ambos existen", () => {
  const contact = {
    id: "contact-1",
    phone_e164: "+5492213000000",
    whatsapp_id: "5492213000000",
    whatsapp_user_id: "AR.syntheticrecipient1",
    name: "Paciente",
  };
  assert.equal(whatsappRecipient(contact), "5492213000000");
  assert.deepEqual(whatsappRecipientIdentity(contact), {
    value: "5492213000000",
    kind: "wa_id",
  });
});

test("usa el teléfono antes que el BSUID si todavía no observó wa_id", () => {
  assert.deepEqual(
    whatsappRecipientIdentity({
      id: "contact-2",
      phone_e164: "+5492213000001",
      whatsapp_id: null,
      whatsapp_user_id: "AR.syntheticrecipient2",
      name: "Paciente",
    }),
    { value: "5492213000001", kind: "phone" },
  );
});

test("conserva el BSUID como fallback cuando Meta no comparte teléfono", () => {
  assert.deepEqual(
    whatsappRecipientIdentity({
      id: "contact-3",
      phone_e164: null,
      whatsapp_id: null,
      whatsapp_user_id: "AR.syntheticrecipient3",
      name: "Paciente",
    }),
    { value: "AR.syntheticrecipient3", kind: "bsuid" },
  );
});

test("la identidad Coexistence proviene del resolvedor account-scoped", async () => {
  const client = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      assert.equal(name, "resolve_whatsapp_coexistence_recipient");
      assert.equal(args.p_account_id, "account-1");
      assert.equal(args.p_conversation_id, "conversation-1");
      assert.equal(args.p_contact_id, "contact-1");
      return {
        data: [
          {
            recipient_value: "5492213000000",
            identity_kind: "wa_id",
            identity_provenance: "recent_inbound",
          },
        ],
        error: null,
      };
    },
  };
  const identity = await resolveWhatsAppRecipientIdentity({
    client: client as never,
    contact: {
      id: "contact-1",
      phone_e164: "+5492213000000",
      whatsapp_id: "5492213000000",
      whatsapp_user_id: "AR.syntheticrecipient1",
      name: "Paciente",
    },
    conversation: {
      id: "conversation-1",
      contact_id: "contact-1",
      coexistence_account_id: "account-1",
      last_inbound_message_at: new Date().toISOString(),
      automation_mode: "auto",
      needs_human: false,
    },
    credentials: {
      credentialMode: "coexistence",
      accountId: "account-1",
    } as WhatsAppAccountCredentials,
  });
  assert.deepEqual(identity, {
    value: "5492213000000",
    kind: "wa_id",
    provenance: "recent_inbound",
  });
});

test("el snapshot idempotente usa HMAC y nunca guarda el destinatario", async () => {
  const identity = {
    value: "5492213000000",
    kind: "wa_id" as const,
  };
  const first = await whatsappRecipientFingerprint({
    identity,
    accountId: "account-1",
    idempotencyKey: "operator:message:1",
    secret: "synthetic-test-secret",
  });
  const same = await whatsappRecipientFingerprint({
    identity,
    accountId: "account-1",
    idempotencyKey: "operator:message:1",
    secret: "synthetic-test-secret",
  });
  const changed = await whatsappRecipientFingerprint({
    identity: { ...identity, value: "5492213000001" },
    accountId: "account-1",
    idempotencyKey: "operator:message:1",
    secret: "synthetic-test-secret",
  });
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(first, same);
  assert.notEqual(first, changed);
  assert.equal(first.includes(identity.value), false);
});

test("un retry conserva y verifica el destinatario reservado", () => {
  const metadata = {
    recipient_identity_kind: "wa_id",
    recipient_fingerprint_version: 1,
    recipient_fingerprint: "a".repeat(64),
  };
  assert.doesNotThrow(() =>
    assertWhatsAppRecipientSnapshot({
      metadata,
      fingerprint: "a".repeat(64),
      kind: "wa_id",
      required: true,
    }),
  );
  assert.throws(
    () =>
      assertWhatsAppRecipientSnapshot({
        metadata,
        fingerprint: "b".repeat(64),
        kind: "wa_id",
        required: true,
      }),
    /IDEMPOTENCY_CONFLICT/,
  );
  assert.throws(
    () =>
      assertWhatsAppRecipientSnapshot({
        metadata: {},
        fingerprint: "a".repeat(64),
        kind: "wa_id",
        required: true,
      }),
    /IDEMPOTENCY_RECIPIENT_UNVERIFIABLE/,
  );
  assert.doesNotThrow(() =>
    assertWhatsAppRecipientSnapshot({
      metadata: {},
      fingerprint: "a".repeat(64),
      kind: "wa_id",
      required: false,
    }),
  );
});

test("una reserva outbound pendiente nunca se confunde con un envío aceptado", () => {
  assert.equal(
    existingWhatsAppDispatchDisposition({ status: "pending", metadata: {} }),
    "in_progress",
  );
  assert.equal(
    existingWhatsAppDispatchDisposition({ status: "sent", metadata: {} }),
    "completed",
  );
  assert.equal(
    existingWhatsAppDispatchDisposition({
      status: "failed",
      metadata: { error_retryable: true, send_attempts: 2 },
    }),
    "retryable_failure",
  );
  assert.equal(
    existingWhatsAppDispatchDisposition({
      status: "failed",
      metadata: { error_retryable: true, send_attempts: 3 },
    }),
    "terminal_failure",
  );
});

test("la ubicación nativa normaliza texto y rechaza puntos inválidos", () => {
  const location = locationPayload({
    latitude: -38.2657317,
    longitude: -57.8353134,
    name: "  Consultorio de la Dra. Gisela Lentz ",
    address: "Calle 11 1375, Miramar, Buenos Aires",
  });

  assert.deepEqual(location, {
    type: "location",
    location: {
      latitude: -38.2657317,
      longitude: -57.8353134,
      name: "Consultorio de la Dra. Gisela Lentz",
      address: "Calle 11 1375, Miramar, Buenos Aires",
    },
  });
  assert.throws(
    () =>
      locationPayload({
        latitude: Number.NaN,
        longitude: -57.8353134,
        name: "Consultorio",
        address: "Calle 11 1375",
      }),
    (error: unknown) =>
      error instanceof WhatsAppPolicyError &&
      error.code === "INVALID_LOCATION_PAYLOAD",
  );
  assert.throws(
    () =>
      locationPayload({
        latitude: -38.2657317,
        longitude: -181,
        name: "Consultorio",
        address: "Calle 11 1375",
      }),
    /INVALID_LOCATION_PAYLOAD/,
  );
});

test("el snapshot idempotente de ubicación no permite cambiar el pin", () => {
  const location = {
    latitude: -38.2657317,
    longitude: -57.8353134,
    name: "Consultorio de la Dra. Gisela Lentz",
    address: "Calle 11 1375, Miramar, Buenos Aires",
  };
  assert.doesNotThrow(() =>
    assertWhatsAppLocationSnapshot({
      metadata: { location_snapshot_version: 1, location },
      location,
    }),
  );
  assert.throws(
    () =>
      assertWhatsAppLocationSnapshot({
        metadata: {
          location_snapshot_version: 1,
          location: { ...location, longitude: -57.8 },
        },
        location,
      }),
    /IDEMPOTENCY_CONFLICT/,
  );
  assert.throws(
    () =>
      assertWhatsAppLocationSnapshot({
        metadata: { location },
        location,
      }),
    /IDEMPOTENCY_CONFLICT/,
  );
});

test("todo envío automático nuevo queda detrás del kill switch", () => {
  assert.equal(isAutomaticWhatsAppSource("automation"), true);
  assert.equal(isAutomaticWhatsAppSource("reminder"), true);
  assert.equal(isAutomaticWhatsAppSource("deposit_request"), true);
  assert.equal(isAutomaticWhatsAppSource("deposit_confirmation"), true);
  assert.equal(isAutomaticWhatsAppSource("proof_acknowledgement"), true);
  assert.equal(isAutomaticWhatsAppSource("late_proof_acknowledgement"), true);
  assert.equal(isAutomaticWhatsAppSource("business_location"), true);
  assert.equal(isAutomaticWhatsAppSource("hold_expiration"), true);
  assert.equal(isAutomaticWhatsAppSource("operator"), false);
  assert.equal(isAutomaticWhatsAppSource("operator_deposit_request"), false);
  assert.equal(
    isAutomaticWhatsAppSource("operator_deposit_confirmation"),
    false,
  );
});

test("sólo la automatización causal exige un lease de ejecución", () => {
  assert.equal(requiresWhatsAppAutomationExecutionLease("automation"), true);
  assert.equal(requiresWhatsAppAutomationExecutionLease("handoff"), true);
  assert.equal(
    requiresWhatsAppAutomationExecutionLease("deposit_request"),
    true,
  );
  assert.equal(
    requiresWhatsAppAutomationExecutionLease("proof_acknowledgement"),
    true,
  );
  assert.equal(
    requiresWhatsAppAutomationExecutionLease("business_location"),
    true,
  );
  assert.equal(requiresWhatsAppAutomationExecutionLease("reminder"), false);
  assert.equal(
    requiresWhatsAppAutomationExecutionLease("hold_expiration"),
    false,
  );
  assert.equal(requiresWhatsAppAutomationExecutionLease("operator"), false);
});

test("sólo el aviso causado por el inbound que tomó el handoff atraviesa manual", () => {
  const owned = {
    pauseSource: "inbound_handoff",
    pauseMessageId: "message-1",
    inboundMessageId: "message-1",
  };
  assert.equal(
    isCausallyOwnedManualAutomationNotice({
      ...owned,
      source: "urgent_handoff",
    }),
    true,
  );
  assert.equal(
    isCausallyOwnedManualAutomationNotice({
      ...owned,
      source: "proof_acknowledgement",
    }),
    true,
  );
  assert.equal(
    isCausallyOwnedManualAutomationNotice({
      ...owned,
      source: "late_proof_acknowledgement",
    }),
    true,
  );
  assert.equal(
    isCausallyOwnedManualAutomationNotice({
      ...owned,
      source: "automation",
    }),
    false,
  );
  assert.equal(
    isCausallyOwnedManualAutomationNotice({
      ...owned,
      source: "handoff",
      pauseSource: "app_echo",
    }),
    false,
  );
  assert.equal(
    isCausallyOwnedManualAutomationNotice({
      ...owned,
      source: "handoff",
      inboundMessageId: "message-2",
    }),
    false,
  );
});

test("un acuse de comprobante exige el mismo proof y el estado vigente", () => {
  const currentReview = {
    status: "scheduled",
    deposit_status: "proof_received",
    deposit_proof_late: false,
    deposit_proof_message_id: "proof-1",
  };
  assert.equal(
    isCurrentDepositProofAcknowledgement({
      source: "proof_acknowledgement",
      automationOwnerMessageId: "proof-1",
      appointment: currentReview,
    }),
    true,
  );
  assert.equal(
    isCurrentDepositProofAcknowledgement({
      source: "proof_acknowledgement",
      automationOwnerMessageId: "proof-1",
      appointment: { ...currentReview, status: "confirmed" },
    }),
    false,
  );
  assert.equal(
    isCurrentDepositProofAcknowledgement({
      source: "proof_acknowledgement",
      automationOwnerMessageId: "proof-1",
      appointment: {
        ...currentReview,
        deposit_proof_message_id: "proof-2",
      },
    }),
    false,
  );

  const currentLate = {
    status: "cancelled",
    deposit_status: "expired",
    deposit_proof_late: true,
    deposit_proof_message_id: "proof-late",
  };
  assert.equal(
    isCurrentDepositProofAcknowledgement({
      source: "late_proof_acknowledgement",
      automationOwnerMessageId: "proof-late",
      appointment: currentLate,
    }),
    true,
  );
  assert.equal(
    isCurrentDepositProofAcknowledgement({
      source: "late_proof_acknowledgement",
      automationOwnerMessageId: "proof-late",
      appointment: { ...currentLate, status: "confirmed" },
    }),
    false,
  );
});

test("reconoce la barrera SQL de modo manual como política no reintentable", () => {
  assert.equal(
    whatsAppPolicyCode(new WhatsAppPolicyError("AUTOMATION_PAUSED")),
    "AUTOMATION_PAUSED",
  );
  assert.equal(
    whatsAppPolicyCode({
      message: "WHATSAPP_AUTOMATION_EFFECT_BLOCKED_MANUAL",
    }),
    "AUTOMATION_PAUSED",
  );
  assert.equal(
    whatsAppPolicyCode({
      message: "WHATSAPP_AUTOMATION_EFFECT_BLOCKED_HUMAN_REPLY",
    }),
    "AUTOMATION_SUPERSEDED_BY_HUMAN_REPLY",
  );
  assert.equal(
    whatsAppPolicyCode({
      message: "WHATSAPP_AUTOMATION_EFFECT_BLOCKED_OPERATIONAL",
    }),
    "AUTOMATIONS_DISABLED",
  );
  assert.equal(whatsAppPolicyCode({ message: "DB_TIMEOUT" }), null);
});

test("automatización distingue credenciales transitorias de barreras terminales", () => {
  assert.equal(
    isRetryableWhatsAppAutomationFailure(
      new WhatsAppCredentialResolutionError(
        "WHATSAPP_CREDENTIAL_RESOLUTION_FAILED",
        { retryable: true },
      ),
    ),
    true,
  );
  assert.equal(
    isRetryableWhatsAppAutomationFailure(
      new WhatsAppCredentialResolutionError(
        "WHATSAPP_BUSINESS_CREDENTIAL_ACCOUNT_BLOCKED",
      ),
    ),
    false,
  );
});

test("el navegador sólo puede elegir propósitos manuales allowlisted", () => {
  assert.equal(isOperatorWhatsAppPurpose("operator_message"), true);
  assert.equal(isOperatorWhatsAppPurpose("operator_deposit_request"), true);
  assert.equal(
    isOperatorWhatsAppPurpose("operator_deposit_confirmation"),
    true,
  );
  assert.equal(isOperatorWhatsAppPurpose("automation"), false);
  assert.equal(isOperatorWhatsAppPurpose("source_arbitrario"), false);
  assert.equal(operatorSourceForPurpose("operator_message"), "operator");
  assert.equal(
    operatorSourceForPurpose("operator_deposit_request"),
    "operator_deposit_request",
  );
});

test("los flags de seguridad solo aceptan booleanos explícitos", () => {
  assert.equal(parseSafetyBoolean("true", false), true);
  assert.equal(parseSafetyBoolean(" TRUE ", false), true);
  assert.equal(parseSafetyBoolean("false", true), false);
  assert.equal(parseSafetyBoolean(" FALSE ", true), false);
  assert.equal(parseSafetyBoolean(undefined, true), true);
  assert.equal(parseSafetyBoolean("", true), true);
  assert.equal(parseSafetyBoolean("tru", true), true);
  assert.equal(parseSafetyBoolean("yes", false), false);
});

test("normaliza números E.164 sin aceptar contenido ambiguo", () => {
  assert.equal(normalizeWhatsAppNumber("+54 9 221 555-0147"), "5492215550147");
  assert.equal(normalizeWhatsAppNumber("(54) 9 221 555.0147"), "5492215550147");
  assert.equal(normalizeWhatsAppNumber("5492215550147"), "5492215550147");
  assert.equal(normalizeWhatsAppNumber("+54abc92215550147"), null);
  assert.equal(normalizeWhatsAppNumber("0123456789"), null);
  assert.equal(normalizeWhatsAppNumber("1234"), null);
});

test("la allowlist ignora entradas inválidas y elimina duplicados", () => {
  assert.deepEqual(
    [
      ...parseWhatsAppAllowedNumbers(
        "+54 9 221 555-0147, 5492215550147; +54 9 11 5555-0101\ninválido",
      ),
    ],
    ["5492215550147", "5491155550101"],
  );
});

test("test mode es fail-closed y compara números normalizados", () => {
  assert.equal(
    isWhatsAppTestRecipientAllowed("5492215550147", undefined, undefined),
    false,
  );
  assert.equal(
    isWhatsAppTestRecipientAllowed(
      "5492215550147",
      "valor-inválido",
      "+54 9 221 555-0147",
    ),
    true,
  );
  assert.equal(
    isWhatsAppTestRecipientAllowed(
      "5492215550999",
      "true",
      "+54 9 221 555-0147",
    ),
    false,
  );
  assert.equal(
    isWhatsAppTestRecipientAllowed("5492215550999", "false", undefined),
    true,
  );
});
