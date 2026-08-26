import assert from "node:assert/strict";
import test from "node:test";
import { normalizePhoneE164 } from "./phone.ts";

test("normaliza teléfonos argentinos para evitar pacientes duplicados", () => {
  assert.equal(normalizePhoneE164("+54 9 11 1234-5678"), "+5491112345678");
  assert.equal(normalizePhoneE164("9 11 1234-5678"), "+5491112345678");
  assert.equal(normalizePhoneE164("0054 9 11 1234 5678"), "+5491112345678");
  assert.equal(normalizePhoneE164("011 1234-5678"), "+5491112345678");
  assert.equal(normalizePhoneE164("011 15 1234-5678"), "+5491112345678");
  assert.equal(normalizePhoneE164("+1 415 555 0123"), "+14155550123");
});

test("rechaza valores vacíos o fuera de rango E.164", () => {
  assert.equal(normalizePhoneE164(""), null);
  assert.equal(normalizePhoneE164("123"), null);
});
