import assert from "node:assert/strict";
import test from "node:test";
import {
  ensureAppointmentCalendarProjection,
  isCompleteCalendarAvailabilityRefresh,
  isSyncedAppointmentCalendarProjection,
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

function fakeClock() {
  let elapsed = 0;
  return {
    now: () => elapsed,
    sleep: (ms: number) => {
      elapsed += ms;
      return Promise.resolve();
    },
    advance: (ms: number) => {
      elapsed += ms;
    },
  };
}

test("un turno ya sincronizado se confirma sin esperar ni refrescar", async () => {
  const clock = fakeClock();
  let refreshes = 0;
  assert.equal(
    await ensureAppointmentCalendarProjection({
      ...clock,
      readProjection: () =>
        Promise.resolve({ state: "synced", projectionStage: "confirmed" }),
      refresh: () => {
        refreshes += 1;
        return Promise.resolve(true);
      },
    }),
    true,
  );
  assert.equal(clock.now(), 0);
  assert.equal(refreshes, 0);
});

test("espera al worker automático que termina a los 1,7 segundos sin duplicarlo", async () => {
  const clock = fakeClock();
  let refreshes = 0;
  assert.equal(
    await ensureAppointmentCalendarProjection({
      ...clock,
      readProjection: () =>
        Promise.resolve(
          clock.now() >= 1_700
            ? { state: "synced", projectionStage: "confirmed" }
            : { state: "pending" },
        ),
      refresh: () => {
        refreshes += 1;
        return Promise.resolve(true);
      },
    }),
    true,
  );
  assert.equal(clock.now(), 2_000);
  assert.equal(refreshes, 0);
});

test("un worker ocupado permite esperar hasta verificar este turno sincronizado", async () => {
  const clock = fakeClock();
  const refreshTimes: number[] = [];
  const signals: AbortSignal[] = [];
  assert.equal(
    await ensureAppointmentCalendarProjection({
      ...clock,
      readProjection: (signal) => {
        signals.push(signal);
        return Promise.resolve(
          clock.now() >= 3_500
            ? { state: "synced", projectionStage: "pre_reservation" }
            : { state: "pending" },
        );
      },
      refresh: (signal) => {
        signals.push(signal);
        refreshTimes.push(clock.now());
        return Promise.resolve(false);
      },
    }),
    true,
  );
  assert.deepEqual(refreshTimes, [2_000]);
  assert.equal(clock.now(), 3_500);
  assert.ok(signals[0] instanceof AbortSignal);
  assert.ok(signals.every((signal) => signal === signals[0]));
});

test("una respuesta del worker pendiente no bloquea la confirmación y se cancela al terminar", async () => {
  const clock = fakeClock();
  let refreshSignal: AbortSignal | undefined;
  let refreshSettled = false;
  assert.equal(
    await ensureAppointmentCalendarProjection({
      ...clock,
      readProjection: () =>
        Promise.resolve(
          clock.now() >= 3_500
            ? { state: "synced", projectionStage: "confirmed" }
            : { state: "pending" },
        ),
      refresh: (signal) => {
        refreshSignal = signal;
        return new Promise<boolean>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }).finally(() => {
          refreshSettled = true;
        });
      },
    }),
    true,
  );
  assert.equal(clock.now(), 3_500);
  assert.equal(refreshSignal?.aborted, true);
  assert.equal(refreshSettled, true);
});

test("un worker exitoso que procesó otros turnos no autoriza confirmar éste ni reinicia el plazo", async () => {
  const clock = fakeClock();
  let refreshes = 0;
  const readTimes: number[] = [];
  assert.equal(
    await ensureAppointmentCalendarProjection({
      ...clock,
      readProjection: () => {
        readTimes.push(clock.now());
        return Promise.resolve({ state: "pending" });
      },
      refresh: () => {
        refreshes += 1;
        return Promise.resolve(true);
      },
    }),
    false,
  );
  assert.equal(clock.now(), 20_000);
  assert.equal(refreshes, 1);
  assert.ok(readTimes.every((time) => time < 20_000));
});

test("una respuesta perdida se recupera sólo leyendo la proyección exacta confirmada", async () => {
  const clock = fakeClock();
  let refreshes = 0;
  assert.equal(
    await ensureAppointmentCalendarProjection({
      ...clock,
      readProjection: () =>
        Promise.resolve(
          clock.now() >= 3_000
            ? { state: "synced", projectionStage: "pre_reservation" }
            : { state: "pending" },
        ),
      refresh: () => {
        refreshes += 1;
        return Promise.reject(new Error("worker response lost"));
      },
    }),
    true,
  );
  assert.equal(refreshes, 1);
  assert.equal(clock.now(), 3_000);
});

test("conflicto, desconexión o error conservan el turno sin enviar confirmación", async () => {
  for (const state of ["conflict", "unavailable", "error"]) {
    const clock = fakeClock();
    let reads = 0;
    let refreshes = 0;
    assert.equal(
      await ensureAppointmentCalendarProjection({
        ...clock,
        readProjection: () => {
          reads += 1;
          return Promise.resolve({ state });
        },
        refresh: () => {
          refreshes += 1;
          return Promise.resolve(false);
        },
      }),
      false,
    );
    assert.equal(reads, 1);
    assert.equal(refreshes, 0);
    assert.equal(clock.now(), 0);
  }
  assert.equal(
    await ensureAppointmentCalendarProjection({
      readProjection: () => Promise.reject(new Error("database unavailable")),
      refresh: () => Promise.resolve(true),
    }),
    false,
  );
});

test("un estado terminal durante la espera detiene las consultas", async () => {
  const clock = fakeClock();
  let refreshes = 0;
  assert.equal(
    await ensureAppointmentCalendarProjection({
      ...clock,
      readProjection: () =>
        Promise.resolve({
          state: clock.now() >= 2_500 ? "conflict" : "pending",
        }),
      refresh: () => {
        refreshes += 1;
        return Promise.resolve(false);
      },
    }),
    false,
  );
  assert.equal(clock.now(), 2_500);
  assert.equal(refreshes, 1);
});

test("el tiempo de lectura y refresh cuenta dentro del plazo sin consultas posteriores", async () => {
  const clock = fakeClock();
  let refreshes = 0;
  assert.equal(
    await ensureAppointmentCalendarProjection({
      ...clock,
      readProjection: () => {
        assert.ok(clock.now() < 20_000, "no read after the total deadline");
        clock.advance(250);
        return Promise.resolve({ state: "pending" });
      },
      refresh: () => {
        refreshes += 1;
        clock.advance(20_000);
        return Promise.resolve(true);
      },
    }),
    false,
  );
  assert.equal(refreshes, 1);
});

test("una lectura sincronizada que llega después del plazo no confirma el turno", async () => {
  const clock = fakeClock();
  let reads = 0;
  let refreshes = 0;
  assert.equal(
    await ensureAppointmentCalendarProjection({
      ...clock,
      readProjection: () => {
        reads += 1;
        clock.advance(20_001);
        return Promise.resolve({
          state: "synced",
          projectionStage: "confirmed",
        });
      },
      refresh: () => {
        refreshes += 1;
        return Promise.resolve(true);
      },
    }),
    false,
  );
  assert.equal(reads, 1);
  assert.equal(refreshes, 0);
});

const completed = {
  processed: true,
  mode: "automatic",
  outcome: "completed",
  inbound: { truncated: false, skippedReason: null, error: null },
};

const inboundSyncInProgress = {
  ...completed,
  outcome: "skipped",
  inbound: {
    ...completed.inbound,
    skippedReason: "INBOUND_SYNC_IN_PROGRESS",
  },
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

test("booking refresh forwards cancellation from the confirmation deadline", async () => {
  const controller = new AbortController();
  const reason = new Error("confirmation deadline expired");
  let observedSignal: AbortSignal | null | undefined;
  const accepted = await refreshCalendarAvailabilityBeforeBooking({
    projectUrl: "https://project.example.test",
    cronSecret: "opaque-test-secret",
    signal: controller.signal,
    fetcher: (_request, init) => {
      observedSignal = init?.signal;
      assert.ok(observedSignal instanceof AbortSignal);
      return new Promise<Response>((_resolve, reject) => {
        observedSignal?.addEventListener("abort", () =>
          reject(observedSignal?.reason),
        );
        controller.abort(reason);
      });
    },
  });

  assert.equal(accepted, false);
  assert.equal(observedSignal?.aborted, true);
  assert.equal(observedSignal?.reason, reason);
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

test("booking waits for an in-progress inbound sync and requires a complete retry", async () => {
  const clock = fakeClock();
  const requestTimes: number[] = [];
  const signals: AbortSignal[] = [];
  const sleepSignals: AbortSignal[] = [];
  const accepted = await refreshCalendarAvailabilityBeforeBooking({
    ...clock,
    projectUrl: " https://project.example.test/// ",
    cronSecret: " opaque-test-secret ",
    sleep: (milliseconds, signal) => {
      sleepSignals.push(signal);
      assert.equal(milliseconds, 1_000);
      return clock.sleep(milliseconds);
    },
    fetcher: (request, init) => {
      requestTimes.push(clock.now());
      assert.equal(
        String(request),
        "https://project.example.test/functions/v1/process-calendar-sync",
      );
      assert.equal(init?.method, "POST");
      assert.equal(init?.body, "{}");
      assert.equal(
        new Headers(init?.headers).get("x-google-calendar-cron-secret"),
        "opaque-test-secret",
      );
      assert.equal(
        new Headers(init?.headers).get("content-type"),
        "application/json",
      );
      assert.ok(init?.signal instanceof AbortSignal);
      signals.push(init.signal);
      return Promise.resolve(
        Response.json(
          requestTimes.length < 3 ? inboundSyncInProgress : completed,
        ),
      );
    },
  });

  assert.equal(accepted, true);
  assert.deepEqual(requestTimes, [0, 1_000, 2_000]);
  assert.equal(clock.now(), 2_000);
  assert.ok(signals.every((signal) => signal === signals[0]));
  assert.ok(sleepSignals.every((signal) => signal === signals[0]));
});

test("booking never accepts busy as success or renews its 45-second deadline", async () => {
  const clock = fakeClock();
  const requestTimes: number[] = [];
  const accepted = await refreshCalendarAvailabilityBeforeBooking({
    ...clock,
    projectUrl: "https://project.example.test",
    cronSecret: "opaque",
    fetcher: () => {
      assert.ok(clock.now() < 45_000, "no request after the shared deadline");
      requestTimes.push(clock.now());
      return Promise.resolve(Response.json(inboundSyncInProgress));
    },
  });

  assert.equal(accepted, false);
  assert.equal(clock.now(), 45_000);
  assert.equal(requestTimes.length, 45);
  assert.equal(requestTimes.at(-1), 44_000);
});

test("booking does not retry incomplete, malformed or genuinely failed syncs", async () => {
  const invalidResponses = [
    { ...inboundSyncInProgress, processed: false },
    { ...inboundSyncInProgress, mode: "manual" },
    { ...inboundSyncInProgress, outcome: "partial" },
    { ...inboundSyncInProgress, outcome: "completed" },
    { ...inboundSyncInProgress, outcome: "error" },
    {
      ...inboundSyncInProgress,
      inbound: { ...inboundSyncInProgress.inbound, truncated: true },
    },
    {
      ...inboundSyncInProgress,
      inbound: { ...inboundSyncInProgress.inbound, error: "GOOGLE_API_FAILED" },
    },
    {
      ...inboundSyncInProgress,
      inbound: {
        ...inboundSyncInProgress.inbound,
        skippedReason: "DISCONNECTED",
      },
    },
    {
      ...inboundSyncInProgress,
      inbound: { skippedReason: "INBOUND_SYNC_IN_PROGRESS", truncated: false },
    },
    {
      ...inboundSyncInProgress,
      inbound: { skippedReason: "INBOUND_SYNC_IN_PROGRESS", error: null },
    },
    { ...inboundSyncInProgress, inbound: null },
    { ...inboundSyncInProgress, inbound: [] },
    { ...completed, outcome: "partial" },
    { ...completed, inbound: { ...completed.inbound, truncated: true } },
    null,
    [],
    {},
  ];

  for (const response of invalidResponses) {
    const clock = fakeClock();
    let requests = 0;
    assert.equal(
      await refreshCalendarAvailabilityBeforeBooking({
        ...clock,
        projectUrl: "https://project.example.test",
        cronSecret: "opaque",
        fetcher: () => {
          requests += 1;
          return Promise.resolve(Response.json(response));
        },
      }),
      false,
      JSON.stringify(response),
    );
    assert.equal(requests, 1);
    assert.equal(clock.now(), 0);
  }
});

test("a busy retry stops on HTTP, JSON, network or inbound errors", async () => {
  const failures: Array<() => Promise<Response>> = [
    () => Promise.resolve(Response.json(completed, { status: 503 })),
    () =>
      Promise.resolve(Response.json(inboundSyncInProgress, { status: 503 })),
    () => Promise.resolve(new Response("invalid JSON")),
    () => Promise.reject(new Error("network unavailable")),
    () =>
      Promise.resolve(
        Response.json({
          ...inboundSyncInProgress,
          inbound: { ...inboundSyncInProgress.inbound, error: "READ_FAILED" },
        }),
      ),
    () => Promise.resolve(Response.json({ ...completed, outcome: "partial" })),
  ];
  for (const fail of failures) {
    const clock = fakeClock();
    let requests = 0;
    assert.equal(
      await refreshCalendarAvailabilityBeforeBooking({
        ...clock,
        projectUrl: "https://project.example.test",
        cronSecret: "opaque",
        fetcher: () => {
          requests += 1;
          return requests === 1
            ? Promise.resolve(Response.json(inboundSyncInProgress))
            : fail();
        },
      }),
      false,
    );
    assert.equal(requests, 2);
    assert.equal(clock.now(), 1_000);
  }
});

test("fetch and JSON time share the booking retry budget and shorten the final wait", async () => {
  const clock = fakeClock();
  const requestTimes: number[] = [];
  const waits: number[] = [];
  const accepted = await refreshCalendarAvailabilityBeforeBooking({
    ...clock,
    projectUrl: "https://project.example.test",
    cronSecret: "opaque",
    sleep: (milliseconds) => {
      waits.push(milliseconds);
      return clock.sleep(milliseconds);
    },
    fetcher: () => {
      requestTimes.push(clock.now());
      clock.advance(20_000);
      const response = Response.json(inboundSyncInProgress);
      response.json = () => {
        clock.advance(requestTimes.length === 1 ? 3_500 : 400);
        return Promise.resolve(inboundSyncInProgress);
      };
      return Promise.resolve(response);
    },
  });

  assert.equal(accepted, false);
  assert.deepEqual(requestTimes, [0, 24_500]);
  assert.deepEqual(waits, [1_000, 100]);
  assert.equal(clock.now(), 45_000);
});

test("a complete retry arriving at or beyond the shared deadline is rejected", async () => {
  for (const elapsed of [44_999, 45_000, 45_001]) {
    for (const delayedPhase of ["fetch", "json"]) {
      const clock = fakeClock();
      let requests = 0;
      const accepted = await refreshCalendarAvailabilityBeforeBooking({
        ...clock,
        projectUrl: "https://project.example.test",
        cronSecret: "opaque",
        fetcher: () => {
          requests += 1;
          if (requests === 1) {
            return Promise.resolve(Response.json(inboundSyncInProgress));
          }
          const response = Response.json(completed);
          const advanceToResponseTime = () =>
            clock.advance(elapsed - clock.now());
          if (delayedPhase === "fetch") {
            advanceToResponseTime();
          } else {
            response.json = () => {
              advanceToResponseTime();
              return Promise.resolve(completed);
            };
          }
          return Promise.resolve(response);
        },
      });

      assert.equal(
        accepted,
        elapsed < 45_000,
        `${delayedPhase} at ${elapsed}ms`,
      );
      assert.equal(requests, 2);
      assert.equal(clock.now(), elapsed);
    }
  }
});

test("booking cancellation during the busy wait prevents a second request", async () => {
  const clock = fakeClock();
  const controller = new AbortController();
  const reason = new Error("booking execution cancelled");
  let requests = 0;
  let waitSignal: AbortSignal | undefined;
  const accepted = await refreshCalendarAvailabilityBeforeBooking({
    ...clock,
    projectUrl: "https://project.example.test",
    cronSecret: "opaque",
    signal: controller.signal,
    sleep: (_milliseconds, signal) => {
      waitSignal = signal;
      return new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
        controller.abort(reason);
      });
    },
    fetcher: () => {
      requests += 1;
      return Promise.resolve(Response.json(inboundSyncInProgress));
    },
  });

  assert.equal(accepted, false);
  assert.equal(requests, 1);
  assert.equal(waitSignal?.aborted, true);
  assert.equal(waitSignal?.reason, reason);
});

test("booking cancellation during a retry request never accepts a late complete response", async () => {
  const clock = fakeClock();
  const controller = new AbortController();
  let requests = 0;
  const accepted = await refreshCalendarAvailabilityBeforeBooking({
    ...clock,
    projectUrl: "https://project.example.test",
    cronSecret: "opaque",
    signal: controller.signal,
    fetcher: () => {
      requests += 1;
      if (requests === 1) {
        return Promise.resolve(Response.json(inboundSyncInProgress));
      }
      controller.abort(new Error("execution cancelled during request"));
      return Promise.resolve(Response.json(completed));
    },
  });

  assert.equal(accepted, false);
  assert.equal(requests, 2);
  assert.equal(clock.now(), 1_000);
});

test("booking cancellation while parsing a retry never accepts its complete body", async () => {
  const clock = fakeClock();
  const controller = new AbortController();
  let requests = 0;
  let parsedRetry = false;
  const accepted = await refreshCalendarAvailabilityBeforeBooking({
    ...clock,
    projectUrl: "https://project.example.test",
    cronSecret: "opaque",
    signal: controller.signal,
    fetcher: () => {
      requests += 1;
      if (requests === 1) {
        return Promise.resolve(Response.json(inboundSyncInProgress));
      }
      const response = Response.json(completed);
      response.json = () => {
        parsedRetry = true;
        controller.abort(new Error("execution cancelled while parsing"));
        return Promise.resolve(completed);
      };
      return Promise.resolve(response);
    },
  });

  assert.equal(accepted, false);
  assert.equal(requests, 2);
  assert.equal(parsedRetry, true);
  assert.equal(clock.now(), 1_000);
});

test(
  "the real busy wait is interrupted immediately by booking cancellation",
  {
    timeout: 1_000,
  },
  async () => {
    const controller = new AbortController();
    const reason = new Error("booking cancelled during the real wait");
    let requests = 0;
    let parsedBusy = false;
    let observedSignal: AbortSignal | null | undefined;
    const accepted = await refreshCalendarAvailabilityBeforeBooking({
      projectUrl: "https://project.example.test",
      cronSecret: "opaque",
      signal: controller.signal,
      fetcher: (_request, init) => {
        requests += 1;
        observedSignal = init?.signal;
        const response = Response.json(inboundSyncInProgress);
        response.json = () => {
          parsedBusy = true;
          return Promise.resolve(inboundSyncInProgress);
        };
        setTimeout(() => controller.abort(reason), 0);
        return Promise.resolve(response);
      },
    });

    assert.equal(accepted, false);
    assert.equal(requests, 1);
    assert.equal(parsedBusy, true);
    assert.equal(observedSignal?.aborted, true);
    assert.equal(observedSignal?.reason, reason);
  },
);

test(
  "the projection's 20-second deadline aborts and settles a real busy refresh wait",
  { timeout: 1_000 },
  async () => {
    const clock = fakeClock();
    const refreshResults: boolean[] = [];
    let requests = 0;
    let parsedBusy = false;
    let observedSignal: AbortSignal | null | undefined;
    const projected = await ensureAppointmentCalendarProjection({
      ...clock,
      sleep: (milliseconds) => {
        clock.advance(milliseconds);
        // Yield to the real event loop so the refresh reaches its real 1s wait
        // before the accelerated projection clock expires and cancels it.
        return new Promise<void>((resolve) => setTimeout(resolve, 0));
      },
      readProjection: () => Promise.resolve({ state: "pending" }),
      refresh: (signal) =>
        refreshCalendarAvailabilityBeforeBooking({
          projectUrl: "https://project.example.test",
          cronSecret: "opaque",
          signal,
          fetcher: (_request, init) => {
            requests += 1;
            observedSignal = init?.signal;
            const response = Response.json(inboundSyncInProgress);
            response.json = () => {
              parsedBusy = true;
              return Promise.resolve(inboundSyncInProgress);
            };
            return Promise.resolve(response);
          },
        }).then((result) => {
          refreshResults.push(result);
          return result;
        }),
    });

    assert.equal(projected, false);
    assert.equal(clock.now(), 20_000);
    assert.equal(requests, 1);
    assert.equal(parsedBusy, true);
    assert.equal(observedSignal?.aborted, true);
    assert.deepEqual(
      refreshResults,
      [false],
      "the in-flight refresh is settled",
    );
  },
);

test("missing configuration or an already cancelled booking never calls the worker", async () => {
  const controller = new AbortController();
  controller.abort();
  for (const config of [
    { projectUrl: undefined, cronSecret: "opaque" },
    { projectUrl: "https://project.example.test", cronSecret: undefined },
    { projectUrl: " ", cronSecret: "opaque" },
    { projectUrl: "https://project.example.test", cronSecret: " " },
    {
      projectUrl: "https://project.example.test",
      cronSecret: "opaque",
      signal: controller.signal,
    },
  ]) {
    const clock = fakeClock();
    let requests = 0;
    assert.equal(
      await refreshCalendarAvailabilityBeforeBooking({
        ...clock,
        ...config,
        fetcher: () => {
          requests += 1;
          return Promise.resolve(Response.json(completed));
        },
      }),
      false,
    );
    assert.equal(requests, 0);
    assert.equal(clock.now(), 0);
  }
});
