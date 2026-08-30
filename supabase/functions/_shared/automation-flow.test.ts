import assert from "node:assert/strict";
import test from "node:test";

import {
  APPOINTMENT_WELCOME_MESSAGE,
  MAIN_MENU_OPTIONS,
  PATIENT_PROFILE_PROMPTS,
  isMainMenuRequest,
  formatDepositAmountArs,
  missingPatientProfileFields,
  nextInvalidAttempt,
  normalizeUserInput,
  parseAlternatePhoneE164,
  parseAppointmentSelection,
  parseCoverageReply,
  parseContactPhoneReply,
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

test("la bienvenida contiene sólo el saludo solicitado y ninguna lista", () => {
  assert.equal(
    APPOINTMENT_WELCOME_MESSAGE,
    "Hola!!!☺️ Gracias por comunicarte con el Consultorio Odontológico Lentz Gisela. Para agendar tu turno envíanos:",
  );
  assert.doesNotMatch(
    APPOINTMENT_WELCOME_MESSAGE,
    /nombre y apellido|sos paciente|teléfono de contacto|ioma|particular|\n|\b[1-4][.)]/i,
  );
});

test("cada paso del alta pide un solo dato", () => {
  const fieldPattern = {
    name: /nombre|apellido/i,
    is_existing_patient: /atendiste|paciente/i,
    contact_phone: /teléfono|whatsapp|número/i,
    coverage: /cobertura|ioma|particular/i,
  } as const;

  for (const [field, prompt] of Object.entries(PATIENT_PROFILE_PROMPTS)) {
    assert.match(prompt, fieldPattern[field as keyof typeof fieldPattern]);
    for (const [otherField, otherPattern] of Object.entries(fieldPattern)) {
      if (otherField !== field) assert.doesNotMatch(prompt, otherPattern);
    }
    assert.doesNotMatch(prompt, /\n|\b[1-4][.)]/);
  }
});

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
        contactPhoneConfirmed: true,
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
      contactPhoneConfirmed: true,
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

test("confirma el teléfono de contacto actual o guarda uno distinto", () => {
  assert.equal(
    parseContactPhoneReply("profile:phone:whatsapp", "+5492291414102"),
    "+5492291414102",
  );
  assert.equal(
    parseContactPhoneReply("este mismo", "+5492291414102"),
    "+5492291414102",
  );
  assert.equal(
    parseContactPhoneReply("02291 15 555-101", "+5492291414102"),
    "+5492291555101",
  );
  assert.deepEqual(
    parsePatientProfileReply("este WhatsApp", {
      expectedField: "contact_phone",
      primaryPhoneE164: "+5492291414102",
    }).values,
    { contactPhoneConfirmed: true },
  );
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
      contactPhoneConfirmed: true,
      coverage: "ioma",
    }),
    ["is_existing_patient"],
  );
  assert.deepEqual(
    missingPatientProfileFields({
      name: "Paciente",
      isExistingPatient: false,
      contactPhoneConfirmed: true,
      coverage: null,
    }),
    ["name", "coverage"],
  );
  assert.deepEqual(
    missingPatientProfileFields({
      name: "María López",
      isExistingPatient: true,
      contactPhoneConfirmed: false,
      coverage: "particular",
    }),
    ["contact_phone"],
  );
  assert.deepEqual(
    missingPatientProfileFields({
      name: null,
      isExistingPatient: null,
      contactPhoneConfirmed: false,
      coverage: null,
    }),
    ["name", "is_existing_patient", "contact_phone", "coverage"],
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
