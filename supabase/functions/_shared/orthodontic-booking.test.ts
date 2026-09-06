import assert from "node:assert/strict";
import test from "node:test";
import {
  bookingConfirmationCopy,
  ORTHODONTIC_VISIT_OPTIONS,
  orthodonticVisitType,
  parseOrthodonticVisitReply,
} from "./orthodontic-booking.ts";
import {
  informationFlowResumePrompt,
  informationFlowSessionTarget,
} from "./business-location.ts";

test("ortodoncia ofrece dos respuestas explícitas y permite cambiar servicio", () => {
  assert.deepEqual(
    ORTHODONTIC_VISIT_OPTIONS.map((option) => option.id),
    ["ortho:first_visit", "ortho:in_treatment", "ortho:back"],
  );
  for (const option of ORTHODONTIC_VISIT_OPTIONS) {
    assert.ok(option.title.length <= 20);
  }
  for (const answer of [
    "ortho:first_visit",
    "Primera vez",
    "1ra vez",
    "Es mi primera consulta con Gisela",
  ]) {
    assert.equal(parseOrthodonticVisitReply(answer), "first_visit", answer);
  }
  for (const answer of [
    "ortho:in_treatment",
    "En tratamiento",
    "Estoy en tto",
    "Ya estoy en tratamiento con Gisela",
    "Sigo en tratamiento con la Dra. Gisela",
  ]) {
    assert.equal(parseOrthodonticVisitReply(answer), "in_treatment", answer);
  }
});

test("haber sido paciente y las preguntas no establecen tratamiento con Gisela", () => {
  for (const answer of [
    "Ya soy paciente",
    "Ya me atendí con Gisela",
    "Tengo brackets",
    "Sí",
    "No",
    "2",
    "Estoy en tratamiento con otro odontólogo",
    "No estoy en tratamiento",
    "¿En tratamiento?",
    "Estoy en tratamiento, ¿tengo que pagar?",
    "Primera vez o en tratamiento",
    "primera consulta pero ya estoy en tratamiento",
    "ortho:back",
    "",
    "in_treatment",
  ])
    assert.equal(parseOrthodonticVisitReply(answer), null, answer);
  for (const value of [
    null,
    undefined,
    true,
    "",
    "ya soy paciente",
    "ortho:in_treatment",
  ]) {
    assert.equal(orthodonticVisitType(value), null);
  }
  assert.equal(orthodonticVisitType("in_treatment"), "in_treatment");
  assert.equal(orthodonticVisitType("first_visit"), "first_visit");
});

const booking = {
  serviceName: "Ortodoncia / Ortopedia",
  date: "lunes 7",
  time: "10:00",
};

test("tratamiento no pide seña ni anticipa una reserva antes de confirmar", () => {
  for (const depositEnabled of [true, false]) {
    const copy = bookingConfirmationCopy({
      ...booking,
      depositEnabled,
      visitType: "in_treatment",
    });
    assert.equal(copy.confirmLabel, "Reservar turno");
    assert.equal(copy.depositRequired, false);
    assert.match(copy.message, /En tratamiento con Gisela/);
    assert.match(copy.message, /no requiere seña/);
    assert.match(copy.message, /todavía no está reservado/);
    assert.doesNotMatch(
      copy.message,
      /Pre-reservar|enviás la seña|alias|comprobante/,
    );
  }
});

test("primera consulta y otros servicios conservan política global de seña", () => {
  for (const visitType of ["first_visit", null] as const) {
    const required = bookingConfirmationCopy({
      ...booking,
      depositEnabled: true,
      visitType,
    });
    assert.equal(required.depositRequired, true);
    assert.equal(required.confirmLabel, "Pre-reservar");
    assert.match(required.message, /mientras enviás la seña/);
    const disabled = bookingConfirmationCopy({
      ...booking,
      depositEnabled: false,
      visitType,
    });
    assert.equal(disabled.depositRequired, false);
    assert.equal(disabled.confirmLabel, "Reservar turno");
    assert.doesNotMatch(
      disabled.message,
      /enviás la seña|En tratamiento con Gisela/,
    );
  }
});

test("preguntas laterales retoman ortodoncia y no reintroducen seña en confirmación", () => {
  const context = {
    serviceId: "ortodoncia",
    orthodonticVisitType: "in_treatment",
    depositRequired: false,
  };
  const expiresAt = "2026-09-07T13:00:00Z";
  assert.match(
    informationFlowResumePrompt("selecting_orthodontic_visit_type") ?? "",
    /primera consulta de ortodoncia/,
  );
  assert.match(
    informationFlowResumePrompt("confirming_appointment", context) ?? "",
    /no requiere seña/,
  );
  assert.doesNotMatch(
    informationFlowResumePrompt("confirming_appointment", context) ?? "",
    /pre-reservar/,
  );
  assert.match(
    informationFlowResumePrompt("confirming_appointment", {
      depositRequired: true,
    }) ?? "",
    /pre-reservar/,
  );
  assert.deepEqual(
    informationFlowSessionTarget({
      resumeCurrentFlow: true,
      state: "confirming_appointment",
      context,
      expiresAt,
    }),
    {
      state: "confirming_appointment",
      context,
      expiresAt,
    },
  );
});
