import assert from "node:assert/strict";
import test from "node:test";

import {
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
  business_location_name: "Consultorio de la Dra. Gisela Lentz",
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
        name: "Consultorio de la Dra. Gisela Lentz",
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
    now: new Date("2026-09-01T15:00:00.000Z"),
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
    expiresAt: "2026-09-01T15:15:00.000Z",
    now: new Date("2026-09-01T15:00:00.000Z"),
  });

  assert.deepEqual(target, {
    state: "collecting_patient_profile",
    context,
    expiresMinutes: 15,
  });
  assert.equal(target.context, context);
  assert.deepEqual(
    informationFlowSessionTarget({
      resumeCurrentFlow: true,
      state: "reviewing_appointments",
      context: { invalidAttempts: 1 },
      expiresAt: "2026-09-01T15:15:00.000Z",
      now: new Date("2026-09-01T15:00:00.000Z"),
    }),
    {
      state: "reviewing_appointments",
      context: { invalidAttempts: 1 },
      expiresMinutes: 15,
    },
  );
  assert.deepEqual(
    informationFlowSessionTarget({
      resumeCurrentFlow: false,
      state: "selecting_service",
      context,
      expiresAt: null,
      now: new Date("2026-09-01T15:00:00.000Z"),
    }),
    { state: "idle" },
  );
});
