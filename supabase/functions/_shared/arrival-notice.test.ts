import assert from "node:assert/strict";
import test from "node:test";

import {
  ARRIVAL_NOTICE_MESSAGE,
  appendArrivalNotice,
  needsArrivalNotice,
} from "./arrival-notice.ts";

const TIMEZONE = "America/Argentina/Buenos_Aires";
// Buenos Aires es UTC-3: 16:00Z es 13:00 local.
const AT_12_59 = "2026-09-14T15:59:00.000Z";
const AT_13_00 = "2026-09-14T16:00:00.000Z";
const AT_16_59 = "2026-09-14T19:59:00.000Z";
const AT_17_00 = "2026-09-14T20:00:00.000Z";

test("la franja sin atención administrativa va de 13 a 17 en la zona del consultorio", () => {
  assert.equal(needsArrivalNotice(AT_12_59, TIMEZONE), false);
  assert.equal(needsArrivalNotice(AT_13_00, TIMEZONE), true);
  assert.equal(needsArrivalNotice(AT_16_59, TIMEZONE), true);
  assert.equal(needsArrivalNotice(AT_17_00, TIMEZONE), false);
});

test("una fecha o una zona que no se pueden leer nunca agregan el aviso", () => {
  assert.equal(needsArrivalNotice("no es una fecha", TIMEZONE), false);
  assert.equal(needsArrivalNotice(AT_13_00, "Zona/Inventada"), false);
  assert.equal(
    appendArrivalNotice("Tu turno quedó confirmado.", "", TIMEZONE),
    "Tu turno quedó confirmado.",
  );
});

test("el aviso se suma una sola vez y respeta el mensaje original", () => {
  const confirmed = "¡Listo! Tu turno quedó confirmado.";

  const withNotice = appendArrivalNotice(confirmed, AT_13_00, TIMEZONE);
  assert.ok(withNotice.startsWith(confirmed));
  assert.ok(withNotice.includes(ARRIVAL_NOTICE_MESSAGE));
  assert.equal(appendArrivalNotice(withNotice, AT_13_00, TIMEZONE), withNotice);

  assert.equal(appendArrivalNotice(confirmed, AT_17_00, TIMEZONE), confirmed);
  assert.equal(appendArrivalNotice("", AT_13_00, TIMEZONE), "");
});

test("no arma un mensaje que WhatsApp no podría enviar", () => {
  const almostFull = "a".repeat(4090);
  assert.equal(appendArrivalNotice(almostFull, AT_13_00, TIMEZONE), almostFull);
});
