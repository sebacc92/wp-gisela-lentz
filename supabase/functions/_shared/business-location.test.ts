import assert from "node:assert/strict";
import test from "node:test";

import {
  conciseBusinessLocationMessage,
  configuredBusinessHoursMessage,
  INFORMATION_FOLLOW_UP_BUTTONS,
  informationFlowResumePrompt,
  informationFlowSessionTarget,
  resolveBusinessLocation,
  stableGoogleMapsUrl,
} from "./business-location.ts";
import { locationPayload } from "./whatsapp.ts";

const mapsUrl =
  "https://www.google.com/maps/search/?api=1&query=Centro%20de%20Atenci%C3%B3n%20Profesional%20%28C.A.P.%29&query_place_id=ChIJK5iJNYYQhZURBREHhxeQ9PQ";
const settings = {
  business_address:
    "Calle 11 1375, Miramar, Provincia de Buenos Aires, Argentina",
  business_location_name: "Consultorio de la Odontóloga Gisela Lentz",
  business_location_address: "Calle 11 1375, Miramar, Buenos Aires",
  business_latitude: -38.2657317,
  business_longitude: -57.8353134,
  business_maps_url: mapsUrl,
};

test("la ubicación confirmada genera el payload nativo exacto de WhatsApp", () => {
  const resolved = resolveBusinessLocation(settings);
  assert.ok(resolved);
  assert.deepEqual(
    locationPayload({
      latitude: resolved.latitude,
      longitude: resolved.longitude,
      name: resolved.name,
      address: resolved.address,
    }),
    {
      type: "location",
      location: {
        latitude: -38.2657317,
        longitude: -57.8353134,
        name: "Consultorio de la Odontóloga Gisela Lentz",
        address: "Calle 11 1375, Miramar, Buenos Aires",
      },
    },
  );
});

test("conserva la URL estable de Google Maps como fallback", () => {
  assert.equal(stableGoogleMapsUrl(mapsUrl), mapsUrl);
  assert.equal(resolveBusinessLocation(settings)?.mapsUrl, mapsUrl);
  assert.equal(stableGoogleMapsUrl("https://share.google/shortlink"), null);
  assert.equal(stableGoogleMapsUrl("javascript:alert(1)"), null);
});

test("la copia automática previa al pin es breve y no expone el fallback", () => {
  const resolved = resolveBusinessLocation(settings);
  assert.ok(resolved);
  const message = conciseBusinessLocationMessage(resolved);

  assert.equal(message, "📍 Estamos en Calle 11 1375, Miramar.");
  assert.doesNotMatch(message, /Provincia de Buenos Aires|Argentina|https?:/);
  assert.equal(
    conciseBusinessLocationMessage(settings.business_address),
    message,
  );
  assert.deepEqual(INFORMATION_FOLLOW_UP_BUTTONS, [
    { id: "flow:new", title: "Sacar un turno" },
    { id: "flow:human", title: "Otra consulta" },
  ]);
});

test("la respuesta combinada separa horarios de la ubicación", () => {
  const configuredInfo =
    "El consultorio está en Calle 11 1375, Miramar, Provincia de Buenos Aires.\n\n" +
    "La atención es con turno: lunes de 9:30 a 15 y martes de 13:30 a 17. Los feriados permanece cerrado.\n\n" +
    "Podés escribirnos por WhatsApp.";
  const hours = configuredBusinessHoursMessage(configuredInfo);

  assert.equal(
    hours,
    "La atención es con turno: lunes de 9:30 a 15 y martes de 13:30 a 17. Los feriados permanece cerrado.",
  );
  assert.doesNotMatch(hours ?? "", /Calle|Miramar|Provincia|Argentina/);
  assert.equal(
    configuredBusinessHoursMessage(
      "Calle 11 1375, Miramar. Horarios: lunes de 9 a 15.",
    ),
    null,
  );
});

test("location permanece separado de texto y media", () => {
  const resolved = resolveBusinessLocation(settings);
  assert.ok(resolved);
  const payload = locationPayload(resolved);
  assert.equal(payload.type, "location");
  assert.equal("text" in payload, false);
  assert.equal("image" in payload, false);
  assert.equal("document" in payload, false);
});

test("repetir ubicación conserva el mismo pin y una sesión idle limpia", () => {
  const first = resolveBusinessLocation(settings);
  const second = resolveBusinessLocation({ ...settings });
  assert.deepEqual(second, first);
  assert.notEqual(second, first);

  const sessionArgs = {
    resumeCurrentFlow: false,
    state: "idle",
    context: {},
    expiresAt: null,
  };
  assert.deepEqual(informationFlowSessionTarget(sessionArgs), {
    state: "idle",
  });
  assert.deepEqual(informationFlowSessionTarget({ ...sessionArgs }), {
    state: "idle",
  });
});

test("consultar ubicación durante otro flujo conserva estado, contexto y vencimiento", () => {
  const context = {
    expectedProfileField: "coverage",
    serviceId: "service-1",
  };
  const target = informationFlowSessionTarget({
    resumeCurrentFlow: true,
    state: "collecting_patient_profile",
    context,
    expiresAt: "2026-09-01T15:15:00.321Z",
  });

  assert.deepEqual(target, {
    state: "collecting_patient_profile",
    context,
    expiresAt: "2026-09-01T15:15:00.321Z",
  });
  assert.equal(target.context, context);
  assert.deepEqual(
    informationFlowSessionTarget({
      resumeCurrentFlow: true,
      state: "reviewing_appointments",
      context: { invalidAttempts: 1 },
      expiresAt: "2026-09-01T15:15:00.321Z",
    }),
    {
      state: "reviewing_appointments",
      context: { invalidAttempts: 1 },
      expiresAt: "2026-09-01T15:15:00.321Z",
    },
  );
  assert.deepEqual(
    informationFlowSessionTarget({
      resumeCurrentFlow: false,
      state: "selecting_service",
      context,
      expiresAt: null,
    }),
    { state: "idle" },
  );
});

test("la consulta lateral retoma la pregunta exacta sin menú genérico", () => {
  assert.equal(
    informationFlowResumePrompt("collecting_patient_profile", {
      expectedProfileField: "coverage",
    }),
    "Seguimos con tu turno 😊 ¿Vas a atenderte por IOMA o Particular?",
  );
  assert.equal(
    informationFlowResumePrompt("selecting_slot", {
      slots: [{ startsAt: "2026-09-03T13:00:00.000Z" }],
    }),
    "Seguimos con tu turno 😊 Elegí uno de los horarios disponibles.",
  );
  assert.equal(
    informationFlowResumePrompt("waiting_deposit", {
      appointmentId: "appointment-1",
      depositHelpShown: true,
    }),
    "Seguimos con tu turno 😊 Quedamos atentos al comprobante.",
  );
  for (const activeState of [
    "selecting_service",
    "selecting_slot",
    "confirming_appointment",
    "selecting_appointment_to_reschedule",
    "confirming_reschedule_request",
    "selecting_new_slot",
    "confirming_new_slot",
    "selecting_appointment_to_cancel",
    "confirming_cancellation",
    "reviewing_appointments",
    "waiting_deposit",
  ]) {
    assert.match(
      informationFlowResumePrompt(activeState) ?? "",
      /^Seguimos /,
      activeState,
    );
  }
  for (const passiveState of [
    "idle",
    "out_of_hours",
    "human_handoff",
    "deposit_confirmed",
  ]) {
    assert.equal(informationFlowResumePrompt(passiveState), null);
  }
});

test("la reanudación distingue el alta propia de la de otra persona", () => {
  assert.equal(
    informationFlowResumePrompt("choosing_appointment_patient"),
    "Seguimos con tu turno 😊 ¿El turno es para vos o para otra persona?",
  );
  assert.match(
    informationFlowResumePrompt("collecting_dependent_profile", {
      expectedProfileField: "name",
    }) ?? "",
    /persona que se va a atender/,
  );
  assert.match(
    informationFlowResumePrompt("collecting_patient_profile", {
      expectedProfileField: "name",
    }) ?? "",
    /¿Cuál es tu nombre y apellido\?/,
  );
});

test("repetir ubicación en un flujo produce la misma reanudación", () => {
  const context = {
    expectedProfileField: "coverage",
    serviceId: "service-1",
  };
  const firstPrompt = informationFlowResumePrompt(
    "collecting_patient_profile",
    context,
  );
  const secondPrompt = informationFlowResumePrompt(
    "collecting_patient_profile",
    { ...context },
  );
  assert.equal(secondPrompt, firstPrompt);

  const target = {
    resumeCurrentFlow: true,
    state: "collecting_patient_profile",
    context,
    expiresAt: "2026-09-01T15:15:00.321Z",
  };
  const firstTarget = informationFlowSessionTarget({ ...target });
  const secondTarget = informationFlowSessionTarget({ ...target });
  assert.deepEqual(firstTarget, {
    state: "collecting_patient_profile",
    context,
    expiresAt: "2026-09-01T15:15:00.321Z",
  });
  assert.deepEqual(secondTarget, firstTarget);
  assert.equal(firstTarget.context, context);
});
