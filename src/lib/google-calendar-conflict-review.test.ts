import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  describeCalendarConflictReviewBlock,
  parseCalendarConflictReview,
} from "./google-calendar-conflict-review.ts";

const conflictId = "11111111-1111-4111-8111-111111111111";
function reviewFixture() {
  return {
    conflictId,
    imported: true,
    patientName: "Paciente de prueba",
    local: {
      title: "Paciente de prueba · Particular",
      startsAt: "2026-09-08T13:30:00Z",
      endsAt: "2026-09-08T14:30:00Z",
    },
    remote: {
      title: "Paciente de prueba - Particular",
      startsAt: "2026-09-08T10:30:00-03:00",
      endsAt: "2026-09-08T11:30:00-03:00",
      updatedAt: "2026-09-07T18:00:00Z",
    },
    reviewToken: "a".repeat(64),
    canAcceptTitle: true,
    reason: null,
  };
}

test("la revisión acepta un snapshot válido con token y conserva ambos textos", () => {
  const input = reviewFixture();
  const result = parseCalendarConflictReview(input, conflictId);
  assert.deepEqual(result, input);
});

test("un texto administrativo aprobado por el servidor se conserva sin registrar pagos", () => {
  const input = reviewFixture();
  input.local.title = "Paciente de prueba TF Particular";
  input.remote.title = "Paciente de prueba TF Particular seña 10";
  const result = parseCalendarConflictReview(input, conflictId);
  assert.ok(result);
  assert.equal(result.canAcceptTitle, true);
  assert.equal(result.remote.title, input.remote.title);
  assert.deepEqual(Object.keys(result).sort(), [
    "canAcceptTitle",
    "conflictId",
    "imported",
    "local",
    "patientName",
    "reason",
    "remote",
    "reviewToken",
  ]);
});

test("la revisión rechaza otro conflicto, fuente o contrato incompleto", () => {
  for (const input of [
    null,
    [],
    {},
    { ...reviewFixture(), conflictId: "another" },
    { ...reviewFixture(), imported: false },
    { ...reviewFixture(), canAcceptTitle: "true" },
    { ...reviewFixture(), local: null },
    { ...reviewFixture(), reviewToken: "" },
    { ...reviewFixture(), reviewToken: "token-inventado" },
    { ...reviewFixture(), reason: "No se puede aceptar" },
    {
      ...reviewFixture(),
      remote: { ...reviewFixture().remote, startsAt: null },
    },
    {
      ...reviewFixture(),
      remote: { ...reviewFixture().remote, startsAt: "2026-09-08T12:30:00Z" },
    },
    {
      ...reviewFixture(),
      local: { ...reviewFixture().local, endsAt: "invalid" },
    },
  ]) {
    assert.equal(parseCalendarConflictReview(input, conflictId), null);
  }
});

test("una revisión bloqueada muestra el motivo pero nunca conserva un token habilitante", () => {
  const reason = "El título ya no corresponde al mismo paciente.";
  const result = parseCalendarConflictReview(
    {
      ...reviewFixture(),
      canAcceptTitle: false,
      reason,
      remote: { ...reviewFixture().remote, startsAt: null, endsAt: null },
    },
    conflictId,
  );
  assert.ok(result);
  assert.equal(result.canAcceptTitle, false);
  assert.equal(result.reviewToken, null);
  assert.equal(describeCalendarConflictReviewBlock(result.reason), reason);
  assert.match(
    describeCalendarConflictReviewBlock(null),
    /El turno no se modificó/,
  );
  assert.ok(
    parseCalendarConflictReview(
      { ...reviewFixture(), canAcceptTitle: false, reviewToken: "", reason },
      conflictId,
    ),
  );
});

const page = readFileSync(
  resolve(process.cwd(), "src/routes/app/settings/index.tsx"),
  "utf8",
);
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
  ...args: string[]
) => (...args: unknown[]) => Promise<void>;

function handler(name: string) {
  const body = page.match(
    new RegExp(
      `const ${name} = \\$\\(async \\(conflictId: string\\) => \\{([\\s\\S]*?)\\n  \\}\\);`,
    ),
  )?.[1];
  assert.ok(body, `No se encontró ${name}`);
  return (bindings: Record<string, unknown>) =>
    new AsyncFunction(...Object.keys(bindings), body)(
      ...Object.values(bindings),
    );
}

function actionFixture() {
  const calls: unknown[] = [];
  let loads = 0;
  const googleCalendar = {
    loading: false,
    action: "",
    resolving: "",
    resolvingAction: "",
    conflicts: [{ id: conflictId, imported: true, kind: "metadata_changed" }],
    conflictReview: parseCalendarConflictReview(reviewFixture(), conflictId),
    conflictReviewConfirmed: true,
    error: false,
    message: "",
  };
  const api = {
    invoke: async (
      name: string,
      options: unknown,
    ): Promise<{ data: unknown; error: unknown }> => {
      calls.push({ name, options });
      return { data: { resolved: true }, error: null };
    },
  };
  const bindings = {
    conflictId,
    state: { isAdmin: true },
    googleCalendar,
    parseCalendarConflictReview,
    getSupabaseClient: () => ({ functions: api }),
    loadGoogleCalendarStatus: async () => {
      loads += 1;
      googleCalendar.conflictReview = null;
      googleCalendar.conflictReviewConfirmed = false;
      return true;
    },
  };
  return { calls, api, bindings, loads: () => loads };
}

test("revisar es explícito y sólo ADMIN puede pedir detalles del conflicto importado", async () => {
  const current = actionFixture();
  current.api.invoke = async (name, options) => {
    current.calls.push({ name, options });
    return { data: reviewFixture(), error: null };
  };
  current.bindings.state.isAdmin = false;
  await handler("reviewImportedCalendarConflict")(current.bindings);
  assert.equal(current.calls.length, 0);
  current.bindings.state.isAdmin = true;
  await handler("reviewImportedCalendarConflict")(current.bindings);
  assert.deepEqual(current.calls, [
    {
      name: "google-calendar-conflict-review",
      options: { body: { action: "review", conflictId } },
    },
  ]);
  assert.equal(current.bindings.googleCalendar.conflictReviewConfirmed, false);
  assert.equal(
    current.bindings.googleCalendar.conflictReview?.reviewToken,
    "a".repeat(64),
  );
  assert.equal(current.loads(), 0);
  assert.equal(current.bindings.googleCalendar.resolving, "");
  assert.match(
    page,
    /onClick\$=\{\(\) =>\s*reviewImportedCalendarConflict\(\s*conflict\.id,?\s*\)/,
  );
});

test("aceptar requiere ADMIN, snapshot, token y confirmación expresa", async () => {
  for (const missing of [
    "admin",
    "confirmed",
    "review",
    "token",
    "acceptance",
    "idle",
  ] as const) {
    const current = actionFixture();
    const calendar = current.bindings.googleCalendar;
    if (missing === "admin") current.bindings.state.isAdmin = false;
    if (missing === "confirmed") calendar.conflictReviewConfirmed = false;
    if (missing === "review") calendar.conflictReview = null;
    if (missing === "token") calendar.conflictReview!.reviewToken = null;
    if (missing === "acceptance")
      calendar.conflictReview!.canAcceptTitle = false;
    if (missing === "idle") calendar.resolving = "another";
    await handler("acceptImportedCalendarTitle")(current.bindings);
    assert.equal(current.calls.length, 0, missing);
  }
});

test("aceptar envía sólo identidad del conflicto y token; después recarga sin sincronizar", async () => {
  const current = actionFixture();
  await handler("acceptImportedCalendarTitle")(current.bindings);
  assert.deepEqual(current.calls, [
    {
      name: "google-calendar-conflict-review",
      options: {
        body: {
          action: "accept_title",
          conflictId,
          reviewToken: "a".repeat(64),
        },
      },
    },
  ]);
  assert.equal(current.loads(), 1);
  assert.equal(current.bindings.googleCalendar.conflictReview, null);
  assert.equal(current.bindings.googleCalendar.conflictReviewConfirmed, false);
  assert.equal(current.bindings.googleCalendar.resolving, "");
  assert.match(
    current.bindings.googleCalendar.message,
    /No cambiamos el paciente ni el horario/,
  );
  assert.match(
    current.bindings.googleCalendar.message,
    /Aceptar el texto no registra pagos ni confirma una seña/,
  );
});

test("respuestas fallidas o perdidas descartan el token, refrescan y liberan la acción", async () => {
  for (const action of [
    "reviewImportedCalendarConflict",
    "acceptImportedCalendarTitle",
  ]) {
    const current = actionFixture();
    current.api.invoke = async () => {
      throw new Error("network unavailable");
    };
    await handler(action)(current.bindings);
    assert.equal(current.loads(), 1);
    assert.equal(current.bindings.googleCalendar.conflictReview, null);
    assert.equal(
      current.bindings.googleCalendar.conflictReviewConfirmed,
      false,
    );
    assert.equal(current.bindings.googleCalendar.resolving, "");
    assert.equal(current.bindings.googleCalendar.resolvingAction, "");
    assert.equal(current.bindings.googleCalendar.error, true);
    assert.match(current.bindings.googleCalendar.message, /Revisar cambio/);
  }
});

test("los importados no ofrecen restaurar y el detalle compara ambas versiones sin HTML", () => {
  const data = readFileSync(
    resolve(process.cwd(), "src/lib/supabase/data.ts"),
    "utf8",
  );
  assert.match(data, /google_calendar_imported,contacts!/);
  assert.match(
    data,
    /imported: appointment\?\.google_calendar_imported !== false/,
  );
  assert.match(page, /\{!conflict\.imported && \(/);
  assert.match(page, /!state\.isAdmin \|\|\s*conflict\.imported \|\|/);
  assert.match(page, /Texto guardado al importar/);
  assert.match(page, /Texto actual en Google/);
  assert.match(page, /Aceptar texto de Google/);
  assert.equal(
    (
      page
        .replace(/\s+/g, " ")
        .match(/[Aa]ceptar el texto no registra pagos ni confirma una seña/g) ??
      []
    ).length,
    3,
  );
  assert.match(
    page,
    /type="checkbox"[\s\S]*?checked=\{\s*googleCalendar\.conflictReviewConfirmed\s*\}/,
  );
  assert.doesNotMatch(page, /dangerouslySetInnerHTML/);
  const actions = page.slice(
    page.indexOf("const reviewImportedCalendarConflict"),
    page.indexOf("const loadSelectableGoogleCalendars"),
  );
  assert.doesNotMatch(
    actions,
    /process-calendar-sync|apply_google_calendar_conflict|reject_google_calendar_conflict/,
  );
});
