import assert from "node:assert/strict";
import test from "node:test";

import {
  MAIN_MENU_OPTIONS,
  isMainMenuRequest,
  formatDepositAmountArs,
  missingPatientProfileFields,
  nextInvalidAttempt,
  normalizeUserInput,
  parseAlternatePhoneE164,
  parseAppointmentSelection,
  parseCoverageReply,
  parseExistingPatientReply,
  parsePatientProfileReply,
  parseProfessionalReply,
  parseServiceReply,
  parseSlotIndex,
  resolveAppointmentConfirmation,
  resolveCancellationConfirmation,
  resolveMainMenuIntent,
  resolveRescheduleConfirmation,
  resolveRescheduleRequest,
  renderConfiguredMessage,
} from "./automation-flow.ts";

test("todas las opciones del menú principal resuelven una intención", () => {
  assert.deepEqual(
    MAIN_MENU_OPTIONS.map((option) => resolveMainMenuIntent(option.id)),
    ["new", "reschedule", "appointments", "cancel", "info", "human"],
  );
});

test("entiende las formas habituales de pedir y gestionar turnos", () => {
  assert.equal(resolveMainMenuIntent("Quiero sacar un turno"), "new");
  assert.equal(resolveMainMenuIntent("Necesito turno"), "new");
  assert.equal(resolveMainMenuIntent("turno"), "new");
  assert.equal(resolveMainMenuIntent("Quiero cambiar mi turno"), "reschedule");
  assert.equal(resolveMainMenuIntent("reprogramar"), "reschedule");
  assert.equal(resolveMainMenuIntent("¿Qué turnos tengo?"), "appointments");
  assert.equal(resolveMainMenuIntent("mis turnos"), "appointments");
  assert.equal(resolveMainMenuIntent("Quiero anular el turno"), "cancel");
  assert.equal(resolveMainMenuIntent("cancelar"), "cancel");
  assert.equal(resolveMainMenuIntent("¿Dónde están ubicados?"), "info");
  assert.equal(
    resolveMainMenuIntent("Necesito hablar con una persona"),
    "human",
  );
});

test("normaliza acentos, signos y espacios", () => {
  assert.equal(normalizeUserInput("  ¡Sí, recepción!  "), "si recepcion");
  assert.equal(isMainMenuRequest("Volver al menú"), true);
});

test("deriva a recepción después de dos respuestas inválidas consecutivas", () => {
  assert.deepEqual(nextInvalidAttempt(), {
    attempts: 1,
    shouldHandoff: false,
  });
  assert.deepEqual(nextInvalidAttempt(1), {
    attempts: 2,
    shouldHandoff: true,
  });
});

test("resuelve todas las opciones de confirmación de una reserva", () => {
  assert.equal(
    resolveAppointmentConfirmation("appointment:confirm"),
    "confirm",
  );
  assert.equal(resolveAppointmentConfirmation("appointment:other"), "other");
  assert.equal(resolveAppointmentConfirmation("appointment:cancel"), "menu");
  assert.equal(resolveAppointmentConfirmation("sí"), "confirm");
  assert.equal(resolveAppointmentConfirmation("otro horario"), "other");
  assert.equal(resolveAppointmentConfirmation("cambiar horario"), "other");
  assert.equal(resolveAppointmentConfirmation("volver"), "menu");
});

test("resuelve la confirmación completa de una reprogramación", () => {
  assert.equal(resolveRescheduleRequest("reschedule:yes"), "yes");
  assert.equal(resolveRescheduleRequest("reschedule:no"), "no");
  assert.equal(resolveRescheduleConfirmation("reschedule:confirm"), "confirm");
  assert.equal(resolveRescheduleConfirmation("reschedule:other"), "other");
  assert.equal(resolveRescheduleConfirmation("reschedule:back"), "back");
  assert.equal(resolveRescheduleConfirmation("sí"), "confirm");
  assert.equal(resolveRescheduleConfirmation("cambiar horario"), "other");
});

test("resuelve ambas opciones de cancelación sin ambigüedad", () => {
  assert.equal(resolveCancellationConfirmation("cancel:yes"), "yes");
  assert.equal(resolveCancellationConfirmation("cancel:no"), "no");
  assert.equal(resolveCancellationConfirmation("cancelar turno"), "yes");
  assert.equal(resolveCancellationConfirmation("no cancelar"), "no");
});

test("rechaza índices de horario incompletos o fuera de rango", () => {
  assert.equal(parseSlotIndex("slot:0", 2), 0);
  assert.equal(parseSlotIndex("slot:1", 2), 1);
  assert.equal(parseSlotIndex("slot:", 2), null);
  assert.equal(parseSlotIndex("slot:2", 2), null);
  assert.equal(parseSlotIndex("1", 2), null);
});

test("valida identificadores dinámicos de profesional y turno", () => {
  const id = "10000000-0000-4000-8000-000000000001";
  assert.equal(parseProfessionalReply("pro:any"), "any");
  assert.equal(parseProfessionalReply(`pro:${id}`), id);
  assert.equal(parseProfessionalReply("pro:"), null);
  assert.equal(
    parseAppointmentSelection(`turn:reschedule:${id}`, "reschedule"),
    id,
  );
  assert.equal(parseAppointmentSelection(`turn:cancel:${id}`, "cancel"), id);
  assert.equal(
    parseAppointmentSelection(`turn:cancel:${id}`, "reschedule"),
    null,
  );
});

test("valida identificadores dinámicos de servicio", () => {
  assert.equal(
    parseServiceReply("svc:10000000-0000-4000-8000-000000000001"),
    "10000000-0000-4000-8000-000000000001",
  );
  assert.equal(parseServiceReply("svc:no-valido"), null);
});

test("extrae de forma determinista un perfil enviado en cuatro líneas", () => {
  assert.deepEqual(
    parsePatientProfileReply(
      "1. maría josé pérez\n2. Sí\n3. +54 9 221 555 0101\n4. IOMA",
      { primaryPhoneE164: "+5492215559999" },
    ),
    {
      values: {
        name: "María José Pérez",
        isExistingPatient: true,
        coverage: "ioma",
        alternatePhoneE164: "+5492215550101",
      },
      ambiguous: [],
    },
  );
});

test("extrae respuestas etiquetadas enviadas todas juntas", () => {
  assert.deepEqual(
    parsePatientProfileReply(
      "Nombre y apellido: Ana del Valle\nPaciente de la odontóloga: no\nCobertura: Particular",
    ),
    {
      values: {
        name: "Ana Del Valle",
        isExistingPatient: false,
        coverage: "particular",
      },
      ambiguous: [],
    },
  );
  assert.deepEqual(
    parsePatientProfileReply(
      "Nombre: Sofía Ramos\nSoy paciente de Gisela: sí\nCobertura: IOMA",
    ).values,
    {
      name: "Sofía Ramos",
      isExistingPatient: true,
      coverage: "ioma",
    },
  );
});

test("aprovecha una respuesta posicional completa o sin repetir el teléfono", () => {
  assert.deepEqual(
    parsePatientProfileReply("María López, no, +54 9 221 555 0101, particular")
      .values,
    {
      name: "María López",
      isExistingPatient: false,
      coverage: "particular",
      alternatePhoneE164: "+5492215550101",
    },
  );
  assert.deepEqual(parsePatientProfileReply("Juan Pérez; sí; IOMA").values, {
    name: "Juan Pérez",
    isExistingPatient: true,
    coverage: "ioma",
  });
});

test("acepta respuestas paso a paso sólo para el campo esperado", () => {
  assert.deepEqual(
    parsePatientProfileReply("Lucía Fernández", { expectedField: "name" })
      .values,
    { name: "Lucía Fernández" },
  );
  assert.equal(parseExistingPatientReply("primera vez"), false);
  assert.equal(parseCoverageReply("Tengo IOMA"), "ioma");
  assert.equal(parseCoverageReply("IOMA o Particular"), null);
});

test("no confunde un teléfono principal ni un texto libre con datos faltantes", () => {
  assert.equal(
    parseAlternatePhoneE164(
      "Mi número es +54 9 221 555 0101",
      "+5492215550101",
    ),
    null,
  );
  assert.deepEqual(parsePatientProfileReply("quiero un turno").values, {});
  assert.deepEqual(
    parsePatientProfileReply("quiero turno", { expectedField: "name" }).values,
    {},
  );
  assert.deepEqual(parsePatientProfileReply("IOMA y Particular").ambiguous, [
    "coverage",
  ]);
});

test("enumera únicamente los datos de perfil que todavía faltan", () => {
  assert.deepEqual(
    missingPatientProfileFields({
      name: "María López",
      isExistingPatient: null,
      coverage: "ioma",
    }),
    ["is_existing_patient"],
  );
  assert.deepEqual(
    missingPatientProfileFields({
      name: "Paciente",
      isExistingPatient: false,
      coverage: null,
    }),
    ["name", "coverage"],
  );
});

test("renderiza el mensaje configurable de seña sin hardcodear sus valores", () => {
  const rendered = renderConfiguredMessage(
    "Seña: {deposit_amount}\nAlias: {deposit_alias}\nTitular: {deposit_holder}",
    {
      deposit_amount: formatDepositAmountArs(10000),
      deposit_alias: "odontologa.gisela.mp",
      deposit_holder: "Gisela Vanesa Lentz",
    },
  );
  assert.equal(
    rendered,
    "Seña: $10.000\nAlias: odontologa.gisela.mp\nTitular: Gisela Vanesa Lentz",
  );
});
