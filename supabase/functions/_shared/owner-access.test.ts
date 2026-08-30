import assert from "node:assert/strict";
import test from "node:test";

import {
  detectOwnerRequest,
  isOwnerNumber,
  parseOwnerNumbers,
} from "./owner-access.ts";

const OWNER = "+5492262338010";

test("la allowlist sólo acepta E.164 exacto y descarta el resto", () => {
  const parsed = parseOwnerNumbers(
    ` ${OWNER} , +5492291414102 , 2262338010 , +54 9 2262 33-8010 , , texto `,
  );
  assert.deepEqual([...parsed].sort(), ["+5492262338010", "+5492291414102"]);
  assert.equal(parseOwnerNumbers(undefined).size, 0);
  assert.equal(parseOwnerNumbers("").size, 0);
});

test("sin allowlist configurada nadie recibe información privada", () => {
  // Falla cerrado: un secreto ausente o mal escrito no puede abrir el acceso.
  assert.equal(isOwnerNumber(OWNER, parseOwnerNumbers(undefined)), false);
  assert.equal(
    isOwnerNumber(OWNER, parseOwnerNumbers("no-es-un-numero")),
    false,
  );
});

test("la validación del número es exacta, no por parecido", () => {
  const allowlist = parseOwnerNumbers(OWNER);
  assert.equal(isOwnerNumber(OWNER, allowlist), true);
  assert.equal(isOwnerNumber(` ${OWNER} `, allowlist), true);

  for (const impostor of [
    null,
    undefined,
    "",
    "5492262338010",
    "+549226233801",
    "+54922623380100",
    "+5492262338011",
    "+5492291414102",
  ]) {
    assert.equal(isOwnerNumber(impostor, allowlist), false, String(impostor));
  }
});

test("reconoce el pedido de agenda por día", () => {
  assert.deepEqual(detectOwnerRequest("Me das los turnos de mañana"), {
    kind: "agenda",
    day: "tomorrow",
  });
  assert.deepEqual(detectOwnerRequest("turnos de hoy"), {
    kind: "agenda",
    day: "today",
  });
  assert.deepEqual(detectOwnerRequest("Qué turnos tengo esta semana?"), {
    kind: "agenda",
    day: "week",
  });
  // Sin fecha explícita se responde el día en curso.
  assert.deepEqual(detectOwnerRequest("pasame los turnos"), {
    kind: "agenda",
    day: "today",
  });
});

test("reconoce la consulta por un paciente", () => {
  assert.deepEqual(detectOwnerRequest("datos de Ana Pérez"), {
    kind: "patient",
    query: "datos de ana perez".replace("datos de ", ""),
  });
  assert.deepEqual(detectOwnerRequest("paciente Ana Pérez"), {
    kind: "patient",
    query: "ana perez",
  });
  assert.deepEqual(detectOwnerRequest("telefono de la paciente Ana"), {
    kind: "patient",
    query: "ana",
  });
});

test("un mensaje que no pide nada privado no dispara una respuesta privada", () => {
  for (const body of [
    "",
    "hola",
    "gracias!",
    "buenas tardes",
    "ok",
    // Un mensaje del propio número que no es una consulta no debe devolver
    // datos de pacientes por las dudas.
    "te mando el comprobante",
  ]) {
    assert.equal(detectOwnerRequest(body), null, body);
  }
});
