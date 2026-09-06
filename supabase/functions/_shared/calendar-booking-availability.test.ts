import assert from "node:assert/strict";
import test from "node:test";
import {
  isCompleteCalendarAvailabilityRefresh,
  refreshCalendarAvailabilityBeforeBooking,
} from "./calendar-booking-availability.ts";

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
