import assert from "node:assert/strict";
import test from "node:test";

import {
  APPOINTMENT_WELCOME_MESSAGE,
  asksAboutCoverage,
  hasUnsupportedCoverageStatement,
  needsCoverageChoice,
  asksAboutPrice,
  depositProofReviewMessage,
  MAIN_MENU_OPTIONS,
  PATIENT_PROFILE_PROMPTS,
  isConversationAcknowledgement,
  isConversationGreeting,
  isOtherCoverageReply,
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
  parseSlotSelection,
  requestsMultipleAppointments,
  requestsThirdPartyAppointment,
  appointmentPatientFromText,
  parseAppointmentPatientChoice,
  DEPENDENT_PROFILE_PROMPTS,
  resolveAppointmentConfirmation,
  resolveCancellationConfirmation,
  resolveMainMenuIntent,
  resolveRescheduleConfirmation,
  resolveRescheduleRequest,
  renderConfiguredMessage,
  MAX_SLOTS_OFFERED_PER_DAY,
  selectSlotsForOffer,
} from "./automation-flow.ts";

test("la bienvenida habla como el consultorio y no adelanta la lista", () => {
  assert.equal(
    APPOINTMENT_WELCOME_MESSAGE,
    "👋 ¡Hola! Gracias por comunicarte con el consultorio de la Odontóloga Gisela Lentz. Estoy para ayudarte con turnos y consultas.",
  );
  assert.doesNotMatch(
    APPOINTMENT_WELCOME_MESSAGE,
    /nombre y apellido|sos paciente|teléfono de contacto|ioma|particular|\n|\b[1-4][.)]/i,
  );
  assert.doesNotMatch(
    APPOINTMENT_WELCOME_MESSAGE,
    /\bsoy\s+(?:la\s+dra\.?\s+)?gisela\b|\bsoy\s+gisela\s+lentz\b/i,
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

test("distingue saludos solos de pedidos concretos", () => {
  for (const greeting of [
    "Hola",
    "¡Buen día!",
    "Hola, Gisela",
    "Buenas tardes, doctora",
    "Hola, ¿cómo están?",
  ]) {
    assert.equal(isConversationGreeting(greeting), true, greeting);
  }
  for (const request of [
    "Hola, quiero sacar un turno",
    "Buenas, ¿cuánto sale una limpieza?",
    "Hola, necesito hablar con una persona",
  ]) {
    assert.equal(isConversationGreeting(request), false, request);
  }
});

test("reconoce agradecimientos breves sin ocultar una consulta nueva", () => {
  for (const acknowledgement of [
    "Gracias",
    "Muchas gracias 😊",
    "Dale",
    "Ok, gracias",
    "Joya",
    "Perfecto, gracias",
    "Listo",
    "Buenísimo, muchas gracias",
  ]) {
    assert.equal(
      isConversationAcknowledgement(acknowledgement),
      true,
      acknowledgement,
    );
  }
  for (const request of [
    "Gracias, necesito otro turno",
    "Perfecto, ¿cuánto sale?",
    "Listo el comprobante, ¿lo recibieron?",
  ]) {
    assert.equal(isConversationAcknowledgement(request), false, request);
  }
});

test("detecta consultas explícitas de precio sin confundir la seña", () => {
  for (const priceQuestion of [
    "¿Cuánto sale una limpieza?",
    "¿Qué costo tiene la consulta?",
    "Precio de blanqueamiento",
    "¿Cuál sería el valor?",
    "¿Me pasás el precio de la consulta?",
    "¿Hay algún costo?",
    "Hola buenas tardes. Quería consultar cuanto esta la limpieza dental. Tengo ioma",
    "Que sale la consulta particular?",
  ]) {
    assert.equal(asksAboutPrice(priceQuestion), true, priceQuestion);
  }
  for (const otherMessage of [
    "Ya transferí el valor de la seña.",
    "Quiero un turno para limpieza",
    "¿Cuánto demora una limpieza?",
    "¿Cuánto está demorando la consulta?",
    "¿Qué sale en el mapa?",
    "El turno es particular",
  ]) {
    assert.equal(asksAboutPrice(otherMessage), false, otherMessage);
  }
});

test("varios turnos en un mismo pedido siguen yendo a una persona", () => {
  for (const multipleRequest of [
    "Necesito dos turnos",
    "Quiero turnos para 2 personas",
    "Un turno para mí y otro para mi hija",
    "También necesito uno para mi marido",
    "Necesito turno para mis hijos",
    "Mi hija necesita otro turno",
  ]) {
    assert.equal(
      requestsMultipleAppointments(multipleRequest),
      true,
      multipleRequest,
    );
    assert.equal(
      requestsThirdPartyAppointment(multipleRequest),
      false,
      multipleRequest,
    );
  }
  for (const singleRequest of [
    "Necesito un turno para mí",
    "Necesito un turno para mi hijo",
    "Mi hija necesita un turno",
    "Mi turno es el dos",
    "Quiero reprogramar mi segundo turno",
    "Voy con mi hija a mi turno",
    "Necesito turno para una limpieza",
  ]) {
    assert.equal(
      requestsMultipleAppointments(singleRequest),
      false,
      singleRequest,
    );
  }
});

test("distingue un turno propio de uno para otra persona, y si no está claro pregunta", () => {
  const cases: Array<[string, "self" | "third_party" | null]> = [
    ["Hola! Quería pedir un turno para mi hijo", "third_party"],
    ["Mi hija necesita un turno", "third_party"],
    ["Quiero un turno para un acompañante", "third_party"],
    ["¿Puedo sacar turno para mi mamá?", "third_party"],
    ["Necesito un turno para mí", "self"],
    ["Quiero un turno para mí por IOMA", "self"],
    ["Es para mí", "self"],
    ["Quiero un turno", null],
    ["Necesito turno para una limpieza", null],
    ["Quiero un turno para mi ahijado", null],
    ["Voy con mi hija a mi turno", null],
    ["Necesito dos turnos", null],
  ];
  for (const [message, expected] of cases) {
    assert.equal(appointmentPatientFromText(message), expected, message);
  }
});

test("interpreta la respuesta sobre para quién es el turno", () => {
  assert.equal(parseAppointmentPatientChoice("patient:self"), "self");
  assert.equal(parseAppointmentPatientChoice("patient:other"), "third_party");
  assert.equal(parseAppointmentPatientChoice("patient:dep:sin-uuid"), null);
  for (const reply of ["Para mí", "Es para mi", "yo", "Soy yo"]) {
    assert.equal(parseAppointmentPatientChoice(reply), "self", reply);
  }
  for (const reply of [
    "Otra persona",
    "Para otra persona",
    "para mi hijo",
    "Es para mi mamá",
    "mi hija",
  ]) {
    assert.equal(parseAppointmentPatientChoice(reply), "third_party", reply);
  }
  for (const reply of ["No sé", "Mañana", "IOMA"]) {
    assert.equal(parseAppointmentPatientChoice(reply), null, reply);
  }
});

test("el alta de otra persona pide los mismos datos, pero sobre ella", () => {
  assert.deepEqual(
    Object.keys(DEPENDENT_PROFILE_PROMPTS).sort(),
    Object.keys(PATIENT_PROFILE_PROMPTS).sort(),
  );
  assert.match(DEPENDENT_PROFILE_PROMPTS.name, /persona que se va a atender/);
  assert.match(DEPENDENT_PROFILE_PROMPTS.contact_phone, /este WhatsApp/);
  assert.match(DEPENDENT_PROFILE_PROMPTS.coverage, /esa persona/);
  // Las respuestas sobre un tercero se dan en tercera persona.
  assert.equal(parseExistingPatientReply("Sí, ya se atendió"), true);
  assert.equal(parseExistingPatientReply("Ya es paciente"), true);
  assert.equal(parseExistingPatientReply("Nunca se atendió"), false);
  assert.equal(parseExistingPatientReply("Es la primera vez"), false);
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
  assert.equal(resolveAppointmentConfirmation("Reservar turno"), "confirm");
  assert.equal(resolveAppointmentConfirmation("Pre-reservar"), "confirm");
  assert.equal(resolveAppointmentConfirmation("¿Reservar turno?"), null);
  assert.equal(resolveAppointmentConfirmation("Pre-reservar?"), null);
  assert.equal(
    resolveAppointmentConfirmation("No quiero reservar turno"),
    null,
  );
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

test("acepta un horario por id, número visible o texto completo exacto", () => {
  const labels = ["Lun 07/09 · 09:30", "Mar 08/09 · 13:30"];
  assert.equal(parseSlotSelection("slot:1", labels), 1);
  assert.equal(parseSlotSelection("1", labels), 0);
  assert.equal(parseSlotSelection("Opción 2", labels), 1);
  assert.equal(parseSlotSelection("mar 08/09 - 13:30", labels), 1);
  assert.equal(parseSlotSelection("martes a la tarde", labels), null);
  assert.equal(parseSlotSelection("3", labels), null);
  assert.equal(parseSlotSelection("09:30", labels), null);
  assert.equal(parseSlotSelection("lunes", ["Lunes", "Lunes"]), null);
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

test("aprovecha un perfil natural explícito enviado en líneas", () => {
  assert.deepEqual(
    parsePatientProfileReply(
      "Milagros Ferreyra.\nNo soy paciente de la doctora\nMi teléfono es +5491112345678\nParticular",
      { primaryPhoneE164: "+5491199999999" },
    ),
    {
      values: {
        name: "Milagros Ferreyra",
        isExistingPatient: false,
        contactPhoneConfirmed: true,
        coverage: "particular",
        alternatePhoneE164: "+5491112345678",
      },
      ambiguous: [],
    },
  );

  assert.deepEqual(
    parsePatientProfileReply(
      "Me llamo Tomás Ruiz\nYa me atendí en el consultorio\nMi celular de contacto es 11 2345-6789\nTengo IOMA",
    ).values,
    {
      name: "Tomás Ruiz",
      isExistingPatient: true,
      contactPhoneConfirmed: true,
      coverage: "ioma",
      alternatePhoneE164: "+5491123456789",
    },
  );
});

test("los formatos naturales sólo extraen afirmaciones explícitas", () => {
  assert.deepEqual(
    parsePatientProfileReply(
      "La paciente Milagros Ferreyra necesita un turno y su teléfono está sin señal.",
    ).values,
    {},
  );
  assert.deepEqual(
    parsePatientProfileReply("Ya transferí a +5491112345678").values,
    {},
  );
  assert.deepEqual(
    parsePatientProfileReply("Soy paciente\nNo soy paciente").ambiguous,
    ["is_existing_patient"],
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

test("reconoce coberturas no admitidas sin asignar IOMA ni Particular", () => {
  for (const reply of [
    "profile:coverage:other",
    "Otra cobertura",
    "OSDE",
    "Swiss Medical",
    "Tengo Federada Salud",
    "Tengo PAMI",
    "No tengo IOMA, tengo OSDE",
  ]) {
    assert.equal(isOtherCoverageReply(reply), true, reply);
    assert.equal(parseCoverageReply(reply), null, reply);
    assert.equal(
      parsePatientProfileReply(reply, { expectedField: "coverage" }).values
        .coverage,
      undefined,
      reply,
    );
  }
  for (const supported of ["IOMA", "Particular", "Sin cobertura", "No sé"]) {
    assert.equal(isOtherCoverageReply(supported), false, supported);
  }
  assert.equal(parseCoverageReply("Sin cobertura"), "particular");
  assert.equal(parseCoverageReply("No tengo obra social"), "particular");
});

test("preguntar por una cobertura no equivale a elegirla", () => {
  for (const input of [
    "¿Qué obras sociales atienden?",
    "¿Cuáles son las coberturas?",
    "¿Atienden por IOMA?",
    "¿Atienden por OSDE?",
    "¿Trabaja con Federada Salud?",
    "¿Aceptan Swiss Medical?",
    "¿Aceptan otras prepagas?",
    "¿Puedo atenderme particular?",
    "¿Puedo ir con IOMA?",
    "¿Sirve IOMA?",
    "¿IOMA?",
    "profile:coverage:other",
  ]) {
    assert.equal(asksAboutCoverage(input), true, input);
    assert.equal(parseCoverageReply(input), null, input);
  }
  for (const input of [
    "IOMA",
    "Tengo IOMA",
    "Particular",
    "El turno es particular",
    "¿Qué sale la consulta particular?",
    "¿Cuánto cuesta una limpieza por IOMA?",
    "¿Atienden por la tarde?",
    "¿Trabajan por orden de llegada?",
    "¿Aceptan tarjetas?",
    "¿Qué horarios tienen?",
    "¿Atienden con anestesia?",
    "¿Trabajan con chicos?",
    "¿Atienden con dolor?",
    "Tengo IOMA, ¿puedo ir mañana?",
    "Tengo IOMA, ¿puedo ir con dolor?",
    "Tengo IOMA y puedo ir mañana",
  ])
    assert.equal(asksAboutCoverage(input), false, input);
});

test("una negación o alternativa con otra obra social no completa cobertura", () => {
  for (const input of [
    "No tengo IOMA",
    "No soy particular",
    "No quiero particular",
    "Sin IOMA",
    "IOMA no",
    "Tengo OSDE, no IOMA",
    "IOMA o OSDE",
    "OSDE o IOMA",
    "IOMA o Particular",
    "No soy afiliado a IOMA",
    "No es IOMA, es OSDE",
    "No puedo pagar particular",
    "No quiero ir particular",
    "No sería particular",
  ])
    assert.equal(parseCoverageReply(input), null, input);
  assert.equal(parseCoverageReply("profile:coverage:ioma"), "ioma");
  assert.equal(parseCoverageReply("profile:coverage:particular"), "particular");
  assert.equal(
    parseCoverageReply("Tengo OSDE pero elijo particular"),
    "particular",
  );
  assert.equal(parseCoverageReply("Quiero un turno particular"), "particular");
  assert.equal(parseCoverageReply("Quiero un turno por IOMA"), "ioma");
});

test("una declaración de otra cobertura exige aclaración aunque el perfil ya esté completo", () => {
  for (const input of [
    "Quiero un turno, tengo OSDE",
    "Tengo Swiss Medical",
    "Mi obra social es Unión Personal",
    "Tengo otra cobertura",
    "Soy afiliado de OSDE",
  ])
    assert.equal(hasUnsupportedCoverageStatement(input), true, input);
  for (const input of [
    "Tengo IOMA",
    "Tengo OSDE pero elijo particular",
    "Quiero un turno particular, tengo OSDE",
    "Tengo dolor",
    "Quiero un turno",
  ])
    assert.equal(hasUnsupportedCoverageStatement(input), false, input);
});

test("una mención ambigua pide elegir antes de reutilizar la cobertura guardada", () => {
  for (const input of [
    "Quiero un turno particular para mañana",
    "Necesito un turno particular",
    "Ya no tengo IOMA, quiero sacar un turno",
    "Soy afiliado de OSDE",
    "Quiero un turno, tengo otra obra social",
  ])
    assert.equal(needsCoverageChoice(input), true, input);
  for (const input of [
    "Quiero un turno",
    "Necesito una limpieza",
    "Quiero un turno por IOMA",
    "Quiero un turno particular",
    "profile:coverage:particular",
  ])
    assert.equal(needsCoverageChoice(input), false, input);
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

test("el aviso de revisión nunca excede WhatsApp ni filtra placeholders", () => {
  const fallback =
    "Recibimos tu comprobante. Vamos a revisarlo antes de confirmar el turno.";
  assert.equal(
    depositProofReviewMessage("¡Gracias! Recibimos tu archivo.", false),
    "¡Gracias! Recibimos tu archivo. Vamos a revisarlo antes de confirmar el turno.",
  );
  assert.equal(depositProofReviewMessage("x".repeat(4096), false), fallback);
  assert.equal(
    depositProofReviewMessage("Recibimos {placeholder_desconocido}.", false),
    fallback,
  );
  assert.match(depositProofReviewMessage(null, true), /pre-reserva ya venció/);
});

test("los horarios ofrecidos se reparten entre días, no se agotan en el primero", () => {
  const lunes = ["lun 09:30", "lun 10:00", "lun 10:30", "lun 11:00"];
  const martes = ["mar 13:30", "mar 14:00", "mar 14:30"];
  const miercoles = ["mie 09:30", "mie 10:00"];

  const ofrecidos = selectSlotsForOffer(
    [lunes, martes, miercoles],
    MAX_SLOTS_OFFERED_PER_DAY,
    8,
  );

  // El problema era justamente que el primer día abierto llenaba la lista.
  assert.deepEqual(ofrecidos, [
    "lun 09:30",
    "lun 10:00",
    "mar 13:30",
    "mar 14:00",
    "mie 09:30",
    "mie 10:00",
  ]);
});

test("el reparto respeta el total pedido y tolera días vacíos", () => {
  assert.deepEqual(
    selectSlotsForOffer(
      [
        ["a", "b"],
        ["c", "d"],
      ],
      2,
      3,
    ),
    ["a", "b", "c"],
  );
  assert.deepEqual(selectSlotsForOffer([[], ["c"]], 2, 5), ["c"]);
  assert.deepEqual(selectSlotsForOffer([], 2, 5), []);
  assert.deepEqual(selectSlotsForOffer([["a"]], 0, 5), []);
});
