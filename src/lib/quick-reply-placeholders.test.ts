import assert from "node:assert/strict";
import test from "node:test";
import {
  describePlaceholder,
  interpolateQuickReply,
  quickReplyValues,
  type QuickReplyContext,
} from "./quick-reply-placeholders.ts";

// 2026-09-11T13:30:00Z es viernes 11 a las 10:30 en Buenos Aires.
const STARTS_AT = "2026-09-11T13:30:00.000Z";

function context(
  overrides: Partial<QuickReplyContext> = {},
): QuickReplyContext {
  return {
    patientName: "Ana Gómez",
    appointmentStartsAt: STARTS_AT,
    depositAmountArs: 10_000,
    depositAlias: "gisela.lentz",
    depositHolder: "Gisela Lentz",
    ...overrides,
  };
}

test("saluda con el primer nombre, no con el nombre completo", () => {
  const { text } = interpolateQuickReply("Hola {patient_name}!", context());
  assert.equal(text, "Hola Ana!");
});

test("completa fecha y hora del próximo turno en la zona del consultorio", () => {
  const values = quickReplyValues(context());
  assert.equal(values.appointment_time, "10:30");
  assert.match(values.appointment_date, /viernes/i);
  assert.match(values.appointment_date, /11/);
  assert.match(values.appointment_date, /septiembre/i);
});

test("el importe se muestra en pesos sin decimales", () => {
  assert.equal(quickReplyValues(context()).deposit_amount, "$10.000");
});

test("lo que no se puede resolver queda a la vista y se informa", () => {
  const result = interpolateQuickReply(
    "Hola {patient_name}, te espero el {appointment_date}.",
    context({ appointmentStartsAt: null }),
  );
  assert.equal(result.text, "Hola Ana, te espero el {appointment_date}.");
  assert.deepEqual(result.unresolved, ["appointment_date"]);
});

test("un placeholder desconocido no se borra ni rompe el texto", () => {
  const result = interpolateQuickReply("Valor: {no_existe}", context());
  assert.equal(result.text, "Valor: {no_existe}");
  assert.deepEqual(result.unresolved, ["no_existe"]);
});

test("un placeholder repetido se informa una sola vez", () => {
  const result = interpolateQuickReply(
    "{appointment_time} y {appointment_time}",
    context({ appointmentStartsAt: null }),
  );
  assert.deepEqual(result.unresolved, ["appointment_time"]);
});

test("un turno con fecha inválida no inventa valores", () => {
  const values = quickReplyValues(context({ appointmentStartsAt: "mañana" }));
  assert.equal(values.appointment_date, undefined);
  assert.equal(values.appointment_time, undefined);
});

test("un importe en cero o negativo no se ofrece", () => {
  assert.equal(
    quickReplyValues(context({ depositAmountArs: 0 })).deposit_amount,
    undefined,
  );
  assert.equal(
    quickReplyValues(context({ depositAmountArs: -5 })).deposit_amount,
    undefined,
  );
});

test("los espacios en blanco no cuentan como dato", () => {
  const values = quickReplyValues(
    context({ patientName: "   ", depositAlias: "  " }),
  );
  assert.equal(values.patient_name, undefined);
  assert.equal(values.deposit_alias, undefined);
});

test("un texto sin placeholders queda igual", () => {
  const result = interpolateQuickReply("Gracias, ¡nos vemos!", context());
  assert.equal(result.text, "Gracias, ¡nos vemos!");
  assert.deepEqual(result.unresolved, []);
});

test("los placeholders tienen una etiqueta legible", () => {
  assert.equal(describePlaceholder("deposit_alias"), "Alias para transferir");
  assert.equal(describePlaceholder("otro"), "otro");
});
