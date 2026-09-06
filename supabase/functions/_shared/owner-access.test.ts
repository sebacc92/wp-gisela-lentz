import assert from "node:assert/strict";
import test from "node:test";

import {
  detectOwnerRequest,
  isOwnerNumber,
  parseOwnerNumbers,
  ownerAgendaRange,
  ownerSummarySchedule,
  verifiedOwnerPhone,
  formatOwnerAgenda,
  formatOwnerPatient,
  OWNER_TIMEZONE,
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

test("la agenda usa el día argentino incluso cuando UTC ya pasó a mañana", () => {
  const now = new Date("2026-09-07T00:00:00.000Z"); // domingo 6, 21 h
  assert.deepEqual(ownerAgendaRange("tomorrow", now), {
    from: "2026-09-07T03:00:00.000Z",
    until: "2026-09-08T03:00:00.000Z",
    localDate: "2026-09-06",
  });
  assert.equal(ownerAgendaRange("today", now).from, "2026-09-06T03:00:00.000Z");
  assert.equal(ownerAgendaRange("week", now).until, "2026-09-13T03:00:00.000Z");
  assert.equal(
    ownerAgendaRange("tomorrow", new Date("2026-12-31T23:00:00-03:00")).from,
    "2027-01-01T03:00:00.000Z",
  );
});

test("resumen sólo desde 21:00 hasta 21:15 Argentina, sin recuperación nocturna", () => {
  for (const [timestamp, expected] of [
    ["2026-09-06T23:59:59.999Z", false],
    ["2026-09-07T00:00:00.000Z", true],
    ["2026-09-07T00:14:59.999Z", true],
    ["2026-09-07T00:15:00.000Z", false],
    ["2026-09-07T03:00:00.000Z", false],
  ] as const)
    assert.equal(
      ownerSummarySchedule(new Date(timestamp)).due,
      expected,
      timestamp,
    );
});

test("la identidad privada exige evidencia del webhook, nunca nombre o teléfono editable", () => {
  const owners = parseOwnerNumbers(OWNER);
  assert.equal(
    verifiedOwnerPhone({ verified_sender_phone_e164: OWNER }, owners),
    null,
  );
  assert.equal(
    verifiedOwnerPhone(
      { sender_identity_source: "history", verified_sender_phone_e164: OWNER },
      owners,
    ),
    null,
  );
  assert.equal(
    verifiedOwnerPhone(
      {
        sender_identity_source: "signed_meta_webhook",
        verified_sender_phone_e164: OWNER,
      },
      owners,
    ),
    OWNER,
  );
  assert.equal(
    verifiedOwnerPhone(
      {
        sender_identity_source: "signed_meta_webhook",
        verified_sender_phone_e164: "+5491111111111",
      },
      owners,
    ),
    null,
  );
});

test("una agenda extensa cabe en un solo mensaje y no exporta tratamientos", () => {
  const body = formatOwnerAgenda({
    day: "tomorrow",
    timezone: OWNER_TIMEZONE,
    appointments: Array.from({ length: 100 }, () => ({
      startsAt: "2026-09-07T14:00:00Z",
      patientName: "Paciente sintético de prueba".repeat(5),
      patientPhone: "+5491111111111",
      coverage: "particular",
      service: "diagnóstico privado",
      depositStatus: "confirmed",
    })),
    blocks: Array.from({ length: 40 }, () => ({
      startsAt: "2026-09-07T15:00:00Z",
      endsAt: "2026-09-07T16:00:00Z",
      allDay: false,
    })),
    calendarNeedsReview: true,
  });
  assert.ok(body.length <= 4096, String(body.length));
  assert.match(body, /100 turnos/);
  assert.match(body, /turnos más/);
  assert.doesNotMatch(body, /diagnóstico|5491111111111/);
});

test("los bloqueos de Google aparecen aunque no haya turnos locales", () => {
  const body = formatOwnerAgenda({
    day: "tomorrow",
    timezone: OWNER_TIMEZONE,
    appointments: [],
    blocks: [
      {
        startsAt: "2026-09-07T15:00:00Z",
        endsAt: "2026-09-07T16:00:00Z",
        allDay: false,
      },
    ],
  });
  assert.match(body, /12:00–13:00 · Ocupado/);
  assert.match(body, /Google Calendar/);
});

test("la consulta administrativa no transmite notas libres clínicas", () => {
  const body = formatOwnerPatient({
    query: "Ana",
    timezone: OWNER_TIMEZONE,
    matches: [
      {
        name: "Ana",
        phone: null,
        coverage: null,
        notes: "Diagnóstico confidencial",
        nextAppointment: null,
      },
    ],
  });
  assert.doesNotMatch(body, /Diagnóstico confidencial/);
  assert.match(body, /sistema interno/);
});
