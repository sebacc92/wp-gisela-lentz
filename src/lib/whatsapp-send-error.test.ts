import assert from "node:assert/strict";
import test from "node:test";
import {
  readWhatsAppSendFailure,
  whatsappSendFailureNotice,
} from "./whatsapp-send-error.ts";

test("configuration failures never promise a safe retry", async () => {
  const failure = await readWhatsAppSendFailure({
    error: "CONFIGURATION_INCOMPLETE",
    message: "El envío de WhatsApp está pausado en la configuración.",
    retryable: false,
  });
  assert.equal(failure.retryable, false);
  assert.equal(
    whatsappSendFailureNotice(failure),
    "El envío de WhatsApp está pausado en la configuración.",
  );
});

test("only an explicit retryable response advertises idempotent retry", async () => {
  const retryable = await readWhatsAppSendFailure({
    error: "SEND_FAILED",
    retryable: true,
  });
  assert.match(whatsappSendFailureNotice(retryable), /sin duplicarlo/);

  const unknown = await readWhatsAppSendFailure(null);
  assert.doesNotMatch(whatsappSendFailureNotice(unknown), /sin duplicarlo/);
});

test("reads a bounded JSON error from the Edge response", async () => {
  const response = new Response(
    JSON.stringify({
      error: "CUSTOMER_SERVICE_WINDOW_CLOSED",
      message: "La ventana de atención está cerrada.",
      retryable: false,
    }),
    { status: 409, headers: { "content-type": "application/json" } },
  );
  const failure = await readWhatsAppSendFailure(null, response);
  assert.deepEqual(failure, {
    error: "CUSTOMER_SERVICE_WINDOW_CLOSED",
    message: "La ventana de atención está cerrada.",
    retryable: false,
  });
});
