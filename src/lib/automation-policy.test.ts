import assert from "node:assert/strict";
import test from "node:test";
import {
  containsRestrictedAutomationRequest,
  restrictedAutomationTerm,
} from "./automation-policy.ts";

test("marca pedidos de identidad y datos bancarios", () => {
  for (const value of [
    "Mandanos tu DNI por favor",
    "Necesitamos el CBU para devolverte la seña",
    "Pasame el número de cuenta",
    "Enviá una foto de la tarjeta",
  ]) {
    assert.equal(
      containsRestrictedAutomationRequest(value),
      true,
      `debería marcar: ${value}`,
    );
  }
});

test("marca pedidos de información clínica", () => {
  for (const value of [
    "Contanos tu diagnóstico",
    "¿Qué medicación tomás?",
    "Describí los síntomas",
    "Adjuntá la historia clínica",
  ]) {
    assert.equal(
      containsRestrictedAutomationRequest(value),
      true,
      `debería marcar: ${value}`,
    );
  }
});

test("los acentos no evitan la detección", () => {
  assert.equal(containsRestrictedAutomationRequest("diagnóstico"), true);
  assert.equal(containsRestrictedAutomationRequest("DIAGNOSTICO"), true);
});

test("no marca un recordatorio normal", () => {
  for (const value of [
    "Te recuerdo tu turno de mañana a las 10",
    "Ya recibimos el comprobante, ¡gracias!",
    "El consultorio queda en la calle principal",
  ]) {
    assert.equal(
      containsRestrictedAutomationRequest(value),
      false,
      `no debería marcar: ${value}`,
    );
  }
});

test("no marca una palabra que sólo contiene el término", () => {
  assert.equal(
    containsRestrictedAutomationRequest("recetario"),
    false,
    "el límite de palabra evita el falso positivo",
  );
});

test("informa qué término disparó el aviso", () => {
  assert.equal(restrictedAutomationTerm("Mandá tu DNI"), "dni");
  assert.equal(restrictedAutomationTerm("Todo bien"), null);
});
