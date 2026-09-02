import assert from "node:assert/strict";
import test from "node:test";

import {
  SECRETARY_HANDOFF_MESSAGE,
  SECRETARY_REPLY_ID,
  isSecretaryRequest,
  resolveTypedServiceOption,
  withSecretaryMenuOption,
} from "../whatsapp-automation/flow-options.ts";

test("agrega la opción inequívoca para hablar con la secretaria", () => {
  assert.deepEqual(
    withSecretaryMenuOption([
      { id: "flow:new", title: "Sacar un turno" },
      { id: "flow:human", title: "Hablar con una persona" },
      { id: "flow:info", title: "Horarios y ubicación" },
    ]),
    [
      { id: "flow:new", title: "Sacar un turno" },
      { id: "flow:info", title: "Horarios y ubicación" },
      { id: "flow:secretary", title: "Hablar con la secretaria" },
    ],
  );
  assert.equal(SECRETARY_REPLY_ID, "flow:secretary");
  assert.equal(
    SECRETARY_HANDOFF_MESSAGE,
    "Claro 😊 Voy a derivar tu consulta con la secretaria para que pueda ayudarte por este chat.",
  );
});

test("selecciona secretaria por ID o texto sin depender de acentos o mayúsculas", () => {
  for (const request of [
    "flow:secretary",
    "Hablar con la secretaria",
    "HABLAR CON LA SECRETARIA",
    "Quiero hablar con la secretaría",
    "Necesito hablar con Secretaría",
  ]) {
    assert.equal(isSecretaryRequest(request), true, request);
  }
  assert.equal(isSecretaryRequest("Quiero sacar un turno"), false);
});

test("resuelve servicios escritos contra el catálogo canonical", () => {
  const services = [
    { id: "service-prosthesis", name: "Prótesis" },
    { id: "service-orthodontics", name: "Ortodoncia" },
  ];

  for (const value of ["protesis", "prótesis", "Prótesis"]) {
    assert.equal(
      resolveTypedServiceOption(value, services)?.id,
      "service-prosthesis",
      value,
    );
  }
  for (const value of ["ortodoncia", "Ortodoncia"]) {
    assert.equal(
      resolveTypedServiceOption(value, services)?.id,
      "service-orthodontics",
      value,
    );
  }
  assert.equal(
    resolveTypedServiceOption("Quiero un turno de prótesis", services)?.id,
    "service-prosthesis",
  );
  assert.equal(resolveTypedServiceOption("Endodoncia", services), null);
});

test("un nombre de servicio ambiguo falla cerrado", () => {
  assert.equal(
    resolveTypedServiceOption("Prótesis", [
      { id: "service-prosthesis-a", name: "Prótesis" },
      { id: "service-prosthesis-b", name: "Protesis" },
    ]),
    null,
  );
});
