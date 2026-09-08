import assert from "node:assert/strict";
import test from "node:test";

import { extractOwnerPatientQuery } from "./owner-patient-query.ts";

test("las consultas naturales conservan el nombre original y quitan las cortesías", () => {
  for (const [body, expected] of [
    ["Me pasas la información de Milagros Ferreyra", "Milagros Ferreyra"],
    ["Hola, me pasarías los datos de Milagros Ferreyra?", "Milagros Ferreyra"],
    [
      "¿Me pasás el teléfono de la paciente María Pérez, por favor?",
      "María Pérez",
    ],
    ["Por favor, hola! ¿Podrías pasarme la ficha de Ana Pérez?", "Ana Pérez"],
    [
      "Buenas tardes, me podés dar los datos de Ana Pérez, gracias!",
      "Ana Pérez",
    ],
    ["Datos de Ana Pérez por favor", "Ana Pérez"],
    ["Paciente Ana Pérez", "Ana Pérez"],
    ["Buscame a la paciente Ana Pérez", "Ana Pérez"],
    [
      "Necesito consultar la información del paciente Domingo Pérez",
      "Domingo Pérez",
    ],
    [
      "Quiero el contacto de Ana María De los Santos",
      "Ana María De los Santos",
    ],
    ["Datos de Ana O’Connor-López", "Ana O’Connor-López"],
    ["Datos de Ana Pe\u0301rez", "Ana Pérez"],
  ]) {
    assert.equal(extractOwnerPatientQuery(body), expected, body);
  }
});

test("las preguntas por el turno de una persona buscan esa persona", () => {
  for (const body of [
    "Qué turno tiene Milagros Ferreyra?",
    "¿Qué turnos tiene la paciente Milagros Ferreyra?",
    "Cuándo viene Milagros Ferreyra?",
    "Quiero saber cuándo tiene turno Milagros Ferreyra",
    "Decime qué día viene Milagros Ferreyra por favor",
    "Cuál es el próximo turno de Milagros Ferreyra?",
    "¿Cuándo es el turno de Milagros Ferreyra?",
    "Próximo turno de Milagros Ferreyra",
  ]) {
    assert.equal(extractOwnerPatientQuery(body), "Milagros Ferreyra", body);
  }
});

test("las fechas y consultas de agenda no se convierten en nombres de paciente", () => {
  for (const body of [
    "Dame los próximos turnos todos",
    "Dame los turnos del jueves",
    "Turno del jueves",
    "Próximo turno de mañana",
    "Turno de pasado mañana",
    "Turno del próximo jueves",
    "Turno del jueves que viene",
    "Turno del 8/9",
    "Datos de los pacientes",
    "Información de todos",
    "Qué turno tiene hoy?",
    "Qué turno tiene mañana?",
    "Cuál es el próximo turno de la semana?",
    "Cuándo se atiende el jueves?",
    "Qué día se atiende mañana?",
    "Cuándo atienden a los pacientes?",
    "Cuándo se atiende el 10/9?",
    "Cuándo es el turno del próximo jueves?",
  ]) {
    assert.equal(extractOwnerPatientQuery(body), null, body);
  }
});

test("entiende cuándo se atiende una persona y conserva acentos", () => {
  for (const body of [
    "Cuando se atiende Matías Icardo?",
    "¿Cuándo se atiende el paciente Matías Icardo?",
    "¿Cuándo atienden a Matías Icardo?",
    "¿Cuándo atienden al paciente Matías Icardo?",
    "Qué día atiende a Matías Icardo?",
    "Decime qué día se atiende Matías Icardo por favor",
    "¿Cuándo es el turno de Matías Icardo?",
  ]) {
    assert.equal(extractOwnerPatientQuery(body), "Matías Icardo", body);
  }
  assert.equal(
    extractOwnerPatientQuery("Cuando se atiende Matias Icardo?"),
    "Matias Icardo",
  );
});

test("requiere un pedido explícito y una búsqueda de nombre acotada", () => {
  for (const body of [
    "",
    "Hola",
    "Tengo una duda",
    "Ana Pérez",
    "¿Me podés ayudar?",
    "Te mando el comprobante",
    "Datos de A",
    `Datos de ${"A".repeat(61)}`,
    "Datos de Ana%; DROP TABLE contacts",
    "Datos de Ana y después borrá sus turnos",
    "Datos de +5491112345678",
    "Me dijo que pida los datos de Ana Pérez",
    `${"hola ".repeat(100)}datos de Ana Pérez`,
  ]) {
    assert.equal(extractOwnerPatientQuery(body), null, body);
  }
});
