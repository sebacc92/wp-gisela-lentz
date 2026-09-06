import assert from "node:assert/strict";
import test from "node:test";
import {
  ensureAppointmentCalendarProjection,
  isSyncedAppointmentCalendarProjection,
  isCompleteCalendarAvailabilityRefresh,
  refreshCalendarAvailabilityBeforeBooking,
} from "./calendar-booking-availability.ts";

test("sólo un estado synced con etapa proyectada válida prueba guardado en Google", () => {
  assert.equal(
    isSyncedAppointmentCalendarProjection({
      state: "synced",
      projectionStage: "confirmed",
    }),
    true,
  );
  for (const value of [
    null,
    {},
    { state: "synced" },
    { state: "pending", projectionStage: "confirmed" },
    { state: "synced", projectionStage: "absent" },
  ]) {
    assert.equal(isSyncedAppointmentCalendarProjection(value), false);
  }
});

test("un worker exitoso que procesó otros turnos no autoriza confirmar éste", async () => {
  let reads = 0;
  assert.equal(
    await ensureAppointmentCalendarProjection({
      readProjection: () => {
        reads += 1;
        return Promise.resolve({ state: "pending" });
      },
      refresh: () => Promise.resolve(true),
    }),
    false,
  );
  assert.equal(reads, 2);
});

test("una respuesta perdida se recupera sólo leyendo la proyección exacta confirmada", async () => {
  let reads = 0;
  assert.equal(
    await ensureAppointmentCalendarProjection({
      readProjection: () =>
        Promise.resolve(
          ++reads === 1
            ? { state: "pending" }
            : { state: "synced", projectionStage: "pre_reservation" },
        ),
      refresh: () => Promise.resolve(false),
    }),
    true,
  );
});

test("conflicto, desconexión o error conservan el turno sin enviar confirmación", async () => {
  for (const state of ["conflict", "unavailable"]) {
    assert.equal(
      await ensureAppointmentCalendarProjection({
        readProjection: () => Promise.resolve({ state }),
        refresh: () => {
          throw new Error("must not run");
        },
      }),
      false,
    );
  }
  assert.equal(
    await ensureAppointmentCalendarProjection({
      readProjection: () => Promise.reject(new Error("database unavailable")),
      refresh: () => Promise.resolve(true),
    }),
    false,
  );
});

const completed = {
  processed: true,
  mode: "automatic",
  outcome: "completed",
  inbound: { truncated: false, skippedReason: null, error: null },
};

test("booking accepts only a complete automatic inbound observation", () => {
  assert.equal(isCompleteCalendarAvailabilityRefresh(completed), true);
  for (const invalid of [
    { ...completed, processed: false },
    { ...completed, mode: "manual" },
    { ...completed, outcome: "partial" },
    { ...completed, inbound: { ...completed.inbound, truncated: true } },
    {
      ...completed,
      inbound: { ...completed.inbound, skippedReason: "IN_PROGRESS" },
    },
    { ...completed, inbound: { ...completed.inbound, error: "READ_FAILED" } },
    null,
  ]) {
    assert.equal(isCompleteCalendarAvailabilityRefresh(invalid), false);
  }
});

test("booking refresh calls only the internal Calendar worker", async () => {
  let observedUrl = "";
  let observedHeader = "";
  const accepted = await refreshCalendarAvailabilityBeforeBooking({
    projectUrl: "https://project.example.test/",
    cronSecret: "opaque-test-secret",
    fetcher: (request, init) => {
      observedUrl = String(request);
      observedHeader =
        new Headers(init?.headers).get("x-google-calendar-cron-secret") ?? "";
      return Promise.resolve(Response.json(completed));
    },
  });

  assert.equal(accepted, true);
  assert.equal(
    observedUrl,
    "https://project.example.test/functions/v1/process-calendar-sync",
  );
  assert.equal(observedHeader, "opaque-test-secret");
});

test("booking refresh fails closed on config and response failures", async () => {
  assert.equal(
    await refreshCalendarAvailabilityBeforeBooking({
      projectUrl: undefined,
      cronSecret: undefined,
    }),
    false,
  );
  assert.equal(
    await refreshCalendarAvailabilityBeforeBooking({
      projectUrl: "https://project.example.test",
      cronSecret: "opaque",
      fetcher: () => Promise.resolve(new Response("down", { status: 503 })),
    }),
    false,
  );
  assert.equal(
    await refreshCalendarAvailabilityBeforeBooking({
      projectUrl: "https://project.example.test",
      cronSecret: "opaque",
      fetcher: () => Promise.resolve(new Response("not-json")),
    }),
    false,
  );
});
