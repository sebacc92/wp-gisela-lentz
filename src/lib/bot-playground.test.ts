import assert from "node:assert/strict";
import test from "node:test";
import {
  consentDecisionFromText,
  simulateBotRouting,
  type PlaygroundInput,
} from "./bot-playground.ts";

function input(overrides: Partial<PlaygroundInput> = {}): PlaygroundInput {
  return {
    body: "Hola, quiero sacar un turno",
    type: "text",
    automationsEnabled: true,
    automationMode: "auto",
    optedOut: false,
    ...overrides,
  };
}

test("un pedido de turno normal sigue el flujo automático", () => {
  const result = simulateBotRouting(input());
  assert.equal(result.route, "automatic");
  assert.equal(result.botWouldAnswer, true);
});

test("una urgencia deriva a atención humana con prioridad", () => {
  const result = simulateBotRouting(input({ body: "Tengo dolor intenso" }));
  assert.equal(result.route, "priority_human");
  assert.equal(result.botWouldAnswer, false);
  assert.ok(result.matched.includes("menciona una urgencia"));
});

test("los acentos no evitan la derivación", () => {
  assert.equal(
    simulateBotRouting(input({ body: "¡Es una EMERGENCIA!" })).route,
    "priority_human",
  );
});

test("un mensaje clínico deriva sin prioridad", () => {
  const result = simulateBotRouting(input({ body: "¿Me pasás la receta?" }));
  assert.equal(result.route, "human_review");
  assert.equal(result.botWouldAnswer, false);
});

test("un adjunto que el bot no lee siempre deriva", () => {
  for (const type of ["image", "document", "audio"] as const) {
    const result = simulateBotRouting(input({ type, body: "" }));
    assert.equal(result.route, "human_review", `${type} debería derivar`);
  }
});

test("una baja explícita se reconoce y corta todo", () => {
  const result = simulateBotRouting(input({ body: "Baja por favor" }));
  assert.equal(result.route, "opt_out");
  assert.equal(result.botWouldAnswer, false);
});

test("una baja registrada pesa más que el contenido", () => {
  const result = simulateBotRouting(
    input({ body: "Quiero un turno", optedOut: true }),
  );
  assert.equal(result.route, "paused");
  assert.equal(result.botWouldAnswer, false);
});

test("el kill switch global apaga la respuesta pero no la derivación", () => {
  const normal = simulateBotRouting(input({ automationsEnabled: false }));
  assert.equal(normal.route, "paused");
  assert.equal(normal.botWouldAnswer, false);

  const urgent = simulateBotRouting(
    input({ automationsEnabled: false, body: "sangrado" }),
  );
  assert.match(urgent.detail, /atención humana/i);
});

test("la pausa manual frena al bot en un mensaje corriente", () => {
  const result = simulateBotRouting(input({ automationMode: "manual" }));
  assert.equal(result.route, "paused");
});

test("una urgencia se detecta aunque el chat esté en manual", () => {
  const result = simulateBotRouting(
    input({ automationMode: "manual", body: "accidente" }),
  );
  assert.equal(
    result.route,
    "priority_human",
    "la derivación se evalúa antes que la pausa manual",
  );
});

test("el consentimiento sólo se lee de frases explícitas", () => {
  assert.equal(
    consentDecisionFromText("acepto recibir recordatorios de turnos"),
    "opt_in",
  );
  assert.equal(consentDecisionFromText("dale, buenísimo"), null);
  assert.equal(consentDecisionFromText("quiero darme de baja"), "opt_out");
});

test("el simulador muestra la frase normalizada que ve el clasificador", () => {
  assert.equal(
    simulateBotRouting(input({ body: "  ¿Turno,  por favor?  " }))
      .normalizedPhrase,
    "turno por favor",
  );
});
