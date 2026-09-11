import assert from "node:assert/strict";
import test from "node:test";
import { calendarConflictActions } from "./calendar-conflict-actions.ts";

test("un reagendado propio se puede decidir para cualquiera de los dos lados", () => {
  const actions = calendarConflictActions({
    kind: "reschedule_requested",
    imported: false,
    isAdmin: true,
  });
  assert.equal(actions.canKeepLocal, true);
  assert.equal(actions.canApplyRemote, true);
  assert.equal(actions.canAcceptTitle, false);
});

test("un turno importado no se puede restaurar desde la agenda", () => {
  const actions = calendarConflictActions({
    kind: "reschedule_requested",
    imported: true,
    isAdmin: true,
  });
  assert.equal(
    actions.canKeepLocal,
    false,
    "la agenda no es el origen de un turno importado",
  );
  assert.equal(actions.canApplyRemote, true);
  assert.match(actions.blockedReason ?? "", /editá el evento allá/i);
});

test("una cancelación en Google se puede aceptar o rechazar", () => {
  const actions = calendarConflictActions({
    kind: "cancellation_requested",
    imported: false,
    isAdmin: true,
  });
  assert.equal(actions.canApplyRemote, true);
  assert.equal(actions.canKeepLocal, true);
});

test("un cambio de texto nunca se aplica en bloque", () => {
  const imported = calendarConflictActions({
    kind: "metadata_changed",
    imported: true,
    isAdmin: true,
  });
  assert.equal(imported.canApplyRemote, false);
  assert.equal(imported.canAcceptTitle, true);
  assert.equal(imported.canKeepLocal, false);
});

test("un cambio de texto sobre un turno propio sólo se conserva", () => {
  const own = calendarConflictActions({
    kind: "metadata_changed",
    imported: false,
    isAdmin: true,
  });
  assert.equal(own.canApplyRemote, false);
  assert.equal(own.canAcceptTitle, false);
  assert.equal(own.canKeepLocal, true);
});

test("sin ADMIN no se ofrece ninguna decisión", () => {
  for (const kind of [
    "reschedule_requested",
    "cancellation_requested",
    "metadata_changed",
  ] as const) {
    for (const imported of [true, false]) {
      const actions = calendarConflictActions({
        kind,
        imported,
        isAdmin: false,
      });
      assert.deepEqual(
        [actions.canKeepLocal, actions.canApplyRemote, actions.canAcceptTitle],
        [false, false, false],
        `${kind}/${imported} no debería ofrecer acciones sin ADMIN`,
      );
      assert.match(actions.blockedReason ?? "", /administrador/i);
    }
  }
});
