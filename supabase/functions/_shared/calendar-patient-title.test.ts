import assert from "node:assert/strict";
import test from "node:test";
import {
  calendarPatientNameKey,
  matchCalendarPatientContact,
  matchCalendarPatientService,
  parseCalendarPatientTitle,
} from "./calendar-patient-title.ts";

test("Matías: TF indica ficha y no inventa un tratamiento", () => {
  const hints = parseCalendarPatientTitle("Rivas matias tf particular");
  assert.equal(hints.name, "Rivas matias");
  assert.equal(hints.isPatientCandidate, true);
  assert.equal(hints.isExistingPatient, true);
  assert.equal(hints.coverage, "particular");
  assert.equal(hints.phoneE164, null);
  assert.equal(hints.serviceHint, null);
  assert.equal(hints.orthodonticVisitType, null);
  assert.deepEqual(hints.uncertainties, []);
  assert.equal(
    matchCalendarPatientContact(hints, [
      { id: "matias", name: "Matías Rivas", phone_e164: "+5492235550123" },
    ]).contactId,
    "matias",
  );
});

test("Julián: primera vez y celular pegado a cobertura se extraen sin confundir ortodoncia", () => {
  const hints = parseCalendarPatientTitle(
    "Rivas julian. 1ra vez 2235550123.particular",
  );
  assert.equal(hints.name, "Rivas julian");
  assert.equal(hints.phoneE164, "+5492235550123");
  assert.equal(hints.coverage, "particular");
  assert.equal(hints.isExistingPatient, false);
  assert.equal(hints.orthodonticVisitType, null);
  assert.deepEqual(hints.uncertainties, []);
});

test("reconoce el formato documentado y los prefijos argentinos usuales", () => {
  for (const phone of [
    "2235550123",
    "+54 9 223 555-0123",
    "54 223 5550123",
    "0223 15 5550123",
    "0054 9 223 5550123",
  ]) {
    const hints = parseCalendarPatientTitle(`Ana Pérez · TF · ${phone} · IOMA`);
    assert.equal(hints.name, "Ana Pérez", phone);
    assert.equal(hints.phoneE164, "+5492235550123", phone);
    assert.equal(hints.coverage, "ioma", phone);
    assert.deepEqual(hints.uncertainties, [], phone);
  }
});

test("no convierte horarios, bloqueos ni eventos genéricos en pacientes", () => {
  for (const summary of [
    "Miercoles 930 a 12 hs",
    "Miercoles 16 a 21 hs",
    "Evento sin título",
    "Reunión de equipo",
    "Vacaciones Gisela",
    "Bloqueado Particular",
    "Ana Pérez TF particular cancelado",
    "Ana Pérez TF particular no viene",
    "",
    null,
    undefined,
    "Matías Rivas",
  ]) {
    const hints = parseCalendarPatientTitle(summary);
    assert.equal(hints.isPatientCandidate, false, String(summary));
    assert.equal(
      matchCalendarPatientService(hints, [
        { id: "consulta", name: "Consulta" },
      ]),
      null,
    );
  }
  assert.equal(
    parseCalendarPatientTitle("Domingo Pérez tf particular").isPatientCandidate,
    true,
  );
});

test("un teléfono antes de primera vez no incorpora el 1 del indicador de ficha", () => {
  const hints = parseCalendarPatientTitle(
    "Ana Pérez 2235550123 1ra vez Particular",
  );
  assert.equal(hints.name, "Ana Pérez");
  assert.equal(hints.phoneE164, "+5492235550123");
  assert.equal(hints.isExistingPatient, false);
  assert.deepEqual(hints.uncertainties, []);
});

test("los nombres conservan partículas y apellidos compuestos", () => {
  const hints = parseCalendarPatientTitle(
    "María del Carmen De la Cruz · T.F. · IOMA",
  );
  assert.equal(hints.name, "María del Carmen De la Cruz");
  assert.equal(hints.isExistingPatient, true);
  assert.equal(
    calendarPatientNameKey(hints.name),
    calendarPatientNameKey("De la Cruz Maria del Carmen"),
  );
  assert.notEqual(
    calendarPatientNameKey("Ana María Pérez"),
    calendarPatientNameKey("Ana Pérez"),
  );
  assert.notEqual(
    calendarPatientNameKey("Ana Ana Pérez"),
    calendarPatientNameKey("Ana Pérez"),
  );
});

test("el teléfono compartido de una familia no asigna el turno a otro paciente", () => {
  const hints = parseCalendarPatientTitle(
    "Rivas julian. 1ra vez 2235550123.particular",
  );
  const matias = {
    id: "matias",
    name: "Matías Rivas",
    phone_e164: "+5492235550123",
  };
  assert.deepEqual(matchCalendarPatientContact(hints, [matias]), {
    contactId: null,
    reason: "phone_name_conflict",
    candidateIds: ["matias"],
  });
  assert.equal(
    matchCalendarPatientContact(hints, [
      matias,
      { id: "julian", name: "Julián Rivas", phone_e164: "+5492235550123" },
    ]).contactId,
    "julian",
  );
});

test("rechaza homónimos y usa teléfono sólo si desambigua el mismo nombre", () => {
  const contacts = [
    { id: "ana1", name: "Ana Pérez", phone_e164: "+5492235550123" },
    { id: "ana2", name: "Pérez Ana", phone_e164: "+5492291550124" },
  ];
  assert.equal(
    matchCalendarPatientContact(
      parseCalendarPatientTitle("Ana Pérez TF IOMA"),
      contacts,
    ).reason,
    "ambiguous",
  );
  assert.equal(
    matchCalendarPatientContact(
      parseCalendarPatientTitle("Ana Pérez TF 2291550124 IOMA"),
      contacts,
    ).contactId,
    "ana2",
  );
  assert.equal(
    matchCalendarPatientContact(
      parseCalendarPatientTitle("Ana Pérez TF 2235550125 IOMA"),
      contacts,
    ).reason,
    "phone_name_conflict",
  );
  assert.equal(
    matchCalendarPatientContact(
      parseCalendarPatientTitle("Ana Pérez TF IOMA"),
      [contacts[0], contacts[0]],
    ).contactId,
    "ana1",
  );
});

test("admite el teléfono alternativo pero no nombres parciales ni similitud difusa", () => {
  const hints = parseCalendarPatientTitle("Ana María Pérez TF 2235550123 IOMA");
  const contact = {
    id: "ana",
    name: "Pérez Ana María",
    phone_e164: "+5492291550124",
    alternate_phone_e164: "0223 15 5550123",
  };
  assert.equal(
    matchCalendarPatientContact(hints, [contact]).reason,
    "phone_and_name",
  );
  assert.equal(
    matchCalendarPatientContact(hints, [{ ...contact, name: "Ana Pérez" }])
      .contactId,
    null,
  );
  assert.equal(
    matchCalendarPatientContact(hints, [
      { ...contact, name: "Ana María Peres" },
    ]).contactId,
    null,
  );
});

test("lee la notación real de la agenda: cobertura abreviada y anotaciones de cobro", () => {
  // Títulos tal cual están escritos en el calendario de Gisela.
  const cases: Array<[string, { name: string; coverage: string | null }]> = [
    [
      "IRIART MARIA DEL MAR - PART - TF",
      { name: "IRIART MARIA DEL MAR", coverage: "particular" },
    ],
    ["GAMBOA LEANDRO -TF-IOMA-", { name: "GAMBOA LEANDRO", coverage: "ioma" }],
    [
      "Tomas Benavidez Medina Tf Particular dio seña",
      { name: "Tomas Benavidez Medina", coverage: "particular" },
    ],
    [
      "maria de los angeles salmeron tf no cobrar",
      { name: "maria de los angeles salmeron", coverage: null },
    ],
    [
      "Estela francisco particular 40. Tf",
      { name: "Estela francisco", coverage: "particular" },
    ],
  ];

  for (const [summary, expected] of cases) {
    const hints = parseCalendarPatientTitle(summary);
    assert.equal(hints.name, expected.name, summary);
    assert.equal(hints.coverage, expected.coverage, summary);
    assert.equal(hints.isExistingPatient, true, summary);
    assert.deepEqual(hints.uncertainties, [], summary);
  }
});

test("un título completo de la agenda entra sin revisión y uno incompleto no", () => {
  const complete = parseCalendarPatientTitle(
    "Ibarra Rodríguez Bautista Tf 2291463877 Ioma",
  );
  assert.equal(complete.name, "Ibarra Rodríguez Bautista");
  assert.equal(complete.phoneE164, "+5492291463877");
  assert.equal(complete.coverage, "ioma");
  assert.equal(complete.isExistingPatient, true);
  assert.deepEqual(complete.uncertainties, []);

  // El número de más dígitos no es un teléfono válido: queda para revisar.
  const brokenPhone = parseCalendarPatientTitle(
    "guajardo isidro -tf partic-22914571914",
  );
  assert.equal(brokenPhone.name, "guajardo isidro");
  assert.equal(brokenPhone.coverage, "particular");
  assert.equal(brokenPhone.phoneE164, null);
  assert.ok(brokenPhone.uncertainties.length > 0);
});

test("datos contradictorios y anotaciones desconocidas requieren revisión", () => {
  for (const summary of [
    "Ana Pérez TF IOMA Particular",
    "Ana Pérez TF 1ra vez particular",
    "Ana Pérez rx particular",
    "Ana Pérez zz TF particular",
    "Ana Pérez conducto TF particular",
    "Ana Pérez · TF · IOMA · Pendiente de seña",
    "Ana Pérez TF 2235550123 / 2291550124 particular",
    "Ana Pérez TF 12345678 particular",
  ]) {
    const hints = parseCalendarPatientTitle(summary);
    assert.ok(hints.uncertainties.length > 0, summary);
    assert.equal(
      matchCalendarPatientService(hints, [
        { id: "consulta", name: "Consulta" },
      ]),
      null,
      summary,
    );
  }
  assert.equal(
    parseCalendarPatientTitle("Ana Pérez TF IOMA Particular").coverage,
    null,
  );
  assert.equal(
    parseCalendarPatientTitle("Ana Pérez TF 1ra vez particular")
      .isExistingPatient,
    null,
  );
  assert.equal(
    parseCalendarPatientTitle("Ana Pérez TF 2235550123 / 2291550124 particular")
      .phoneE164,
    null,
  );
});

test("Consulta es el predeterminado sólo sin servicio explícito ni dudas", () => {
  const services = [
    { id: "consulta", name: "Consulta" },
    { id: "extracciones", name: "Extracciones" },
  ];
  assert.equal(
    matchCalendarPatientService(
      parseCalendarPatientTitle("Rivas matias tf particular"),
      services,
    ),
    "consulta",
  );
  const explicit = parseCalendarPatientTitle("Ana Pérez extracción IOMA");
  assert.equal(explicit.name, "Ana Pérez");
  assert.equal(explicit.serviceHint, "extracciones");
  assert.equal(matchCalendarPatientService(explicit, services), "extracciones");
  assert.equal(matchCalendarPatientService(explicit, [services[0]]), null);
  assert.equal(
    matchCalendarPatientService(
      parseCalendarPatientTitle("Ana Pérez TF IOMA"),
      [services[0], { id: "other", name: "Consulta" }],
    ),
    null,
  );
});

test("ficha y primera vez no fijan el tipo de ortodoncia salvo contexto explícito", () => {
  const first = parseCalendarPatientTitle("Ana Pérez ortodoncia 1ra vez IOMA");
  assert.equal(first.orthodonticVisitType, "first_visit");
  const treatment = parseCalendarPatientTitle(
    "Ana Pérez Ortodoncia / Ortopedia en tratamiento con Gisela TF particular",
  );
  assert.equal(treatment.name, "Ana Pérez");
  assert.equal(treatment.orthodonticVisitType, "in_treatment");
  assert.equal(
    matchCalendarPatientService(treatment, [
      { id: "ortho", name: "Ortopedia y ortodoncia" },
    ]),
    "ortho",
  );
  assert.equal(
    parseCalendarPatientTitle("Ana Pérez ortodoncia TF IOMA")
      .orthodonticVisitType,
    null,
  );
  assert.equal(
    parseCalendarPatientTitle("Ana Pérez 1ra vez IOMA").orthodonticVisitType,
    null,
  );
  assert.ok(
    parseCalendarPatientTitle("Ana Pérez en tratamiento TF IOMA").uncertainties
      .length > 0,
  );
});
