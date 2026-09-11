import assert from "node:assert/strict";
import test from "node:test";
import {
  renderTemplatePreview,
  reviewTemplateContent,
  sampleFor,
  templateParameters,
} from "./whatsapp-template-preview.ts";

test("detecta los parámetros usados, ordenados y sin repetir", () => {
  assert.deepEqual(
    templateParameters("Hola {{2}}, el {{1}} y de nuevo {{2}}"),
    [1, 2],
  );
  assert.deepEqual(templateParameters("Sin parámetros"), []);
});

test("la vista previa reemplaza con ejemplos", () => {
  const preview = renderTemplatePreview("Hola {{1}}, te espero el {{2}}.");
  assert.equal(preview, "Hola Ana, te espero el viernes 11 de septiembre.");
});

test("los valores propios tienen prioridad sobre el ejemplo", () => {
  assert.equal(
    renderTemplatePreview("Hola {{1}}", { 1: "Marta" }),
    "Hola Marta",
  );
});

test("un valor en blanco cae al ejemplo en vez de dejar un hueco", () => {
  assert.equal(renderTemplatePreview("Hola {{1}}", { 1: "   " }), "Hola Ana");
});

test("los ejemplos se reciclan si hay más parámetros que muestras", () => {
  assert.equal(sampleFor(1), sampleFor(6));
});

test("marca los pedidos de datos que no pueden viajar por WhatsApp", () => {
  const issues = reviewTemplateContent("Mandanos tu DNI para confirmar");
  assert.equal(issues[0].level, "blocker");
  assert.match(issues[0].message, /dni/i);
});

test("exige parámetros correlativos desde {{1}}", () => {
  const issues = reviewTemplateContent("Hola {{1}}, el día {{3}}");
  assert.ok(issues.some((issue) => /correlativos/.test(issue.message)));
});

test("acepta parámetros correlativos aunque estén desordenados en el texto", () => {
  const issues = reviewTemplateContent("El {{2}} viene {{1}}");
  assert.equal(
    issues.filter((issue) => /correlativos/.test(issue.message)).length,
    0,
  );
});

test("rechaza parámetros con nombre", () => {
  const issues = reviewTemplateContent("Hola {{nombre}}");
  assert.ok(
    issues.some((issue) => /numera los parámetros/.test(issue.message)),
  );
});

test("advierte cuando empieza o termina con un parámetro", () => {
  const issues = reviewTemplateContent("{{1}} te esperamos");
  assert.ok(
    issues.some(
      (issue) =>
        issue.level === "warning" && /empiezan o terminan/.test(issue.message),
    ),
  );
});

test("advierte por enlaces sin bloquear", () => {
  const issues = reviewTemplateContent("Reservá en https://ejemplo.com hoy");
  const link = issues.find((issue) => /enlaces/.test(issue.message));
  assert.equal(link?.level, "warning");
});

test("una plantilla correcta no genera observaciones", () => {
  assert.deepEqual(
    reviewTemplateContent("Hola {{1}}, te recordamos tu turno del {{2}}."),
    [],
  );
});

test("una plantilla vacía se marca y no sigue revisando", () => {
  const issues = reviewTemplateContent("   ");
  assert.equal(issues.length, 1);
  assert.equal(issues[0].level, "blocker");
});
