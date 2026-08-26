import assert from "node:assert/strict";
import test from "node:test";

import {
  existingWhatsAppDispatchDisposition,
  isAutomaticWhatsAppSource,
  isCausallyOwnedManualAutomationNotice,
  isOperatorWhatsAppPurpose,
  isRetryableWhatsAppAutomationFailure,
  isWhatsAppTestRecipientAllowed,
  normalizeWhatsAppNumber,
  operatorSourceForPurpose,
  parseSafetyBoolean,
  parseWhatsAppAllowedNumbers,
  WhatsAppPolicyError,
  whatsAppPolicyCode,
  whatsappRecipient,
} from "./whatsapp.ts";
import { WhatsAppCredentialResolutionError } from "./whatsapp-account-credentials.ts";

test("prioriza el BSUID opaco como destinatario de Graph", () => {
  assert.equal(
    whatsappRecipient({
      id: "contact-1",
      phone_e164: null,
      whatsapp_id: null,
      whatsapp_user_id: "user.syntheticrecipient1",
      name: "Paciente",
    }),
    "user.syntheticrecipient1",
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

test("todo envío automático nuevo queda detrás del kill switch", () => {
  assert.equal(isAutomaticWhatsAppSource("automation"), true);
  assert.equal(isAutomaticWhatsAppSource("reminder"), true);
  assert.equal(isAutomaticWhatsAppSource("deposit_request"), true);
  assert.equal(isAutomaticWhatsAppSource("proof_acknowledgement"), true);
  assert.equal(isAutomaticWhatsAppSource("hold_expiration"), true);
  assert.equal(isAutomaticWhatsAppSource("operator"), false);
  assert.equal(isAutomaticWhatsAppSource("operator_deposit_request"), false);
  assert.equal(
    isAutomaticWhatsAppSource("operator_deposit_confirmation"),
    false,
  );
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
