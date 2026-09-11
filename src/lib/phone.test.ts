import assert from "node:assert/strict";
import test from "node:test";
import { normalizePhoneE164, phoneForAgendaTitle } from "./phone.ts";

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

test("en la agenda el celular va como lo escribe Gisela", () => {
  assert.equal(phoneForAgendaTitle("+5492262338010"), "2262338010");
  assert.equal(phoneForAgendaTitle("+5491100000001"), "1100000001");
});

test("el formato de la agenda vuelve a leerse como el mismo celular", () => {
  for (const e164 of ["+5492262338010", "+5492235550126", "+5491134567890"]) {
    const local = phoneForAgendaTitle(e164);
    assert.ok(local);
    assert.equal(
      normalizePhoneE164(local),
      e164,
      "ida y vuelta: el lector de títulos lo reconoce como el mismo número",
    );
  }
});

test("un número de otro país conserva el prefijo", () => {
  assert.equal(phoneForAgendaTitle("+59899123456"), "+59899123456");
});

test("un valor que no es E.164 no se muestra", () => {
  assert.equal(phoneForAgendaTitle("2262338010"), null);
  assert.equal(phoneForAgendaTitle(""), null);
  assert.equal(phoneForAgendaTitle("+54 9 226"), null);
});
