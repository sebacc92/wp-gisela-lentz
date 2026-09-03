import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

/**
 * La recepción de un comprobante nunca puede lograrse relajando los controles
 * que deciden si el bot está autorizado a responder. Este contrato existe para
 * que un cambio futuro en esa dirección falle en CI.
 */
test("los controles de despacho de automatización siguen intactos", () => {
  const incoming = source("supabase/functions/_shared/incoming-message.ts");

  // El modo manual, la pausa por derivación y el switch global siguen mandando.
  assert.match(incoming, /input\.automationsEnabled &&\s*!input\.optedOut &&/);
  assert.match(
    incoming,
    /\(input\.automationMode === "auto" \|\|\s*input\.humanReviewPauseOwned \|\|\s*input\.owner\)/,
  );
  assert.match(incoming, /const humanReview = requiresHumanReview\(message\)/);
  // Ningún atajo para adjuntos ni para comprobantes.
  assert.doesNotMatch(incoming, /depositProof/i);
  assert.doesNotMatch(incoming, /skipManualMode|bypass/i);
});

test("el acuse de recibo no puede saltar los gates de la automatización", () => {
  const automation = source("supabase/functions/whatsapp-automation/index.ts");
  const kill = automation.indexOf("if (!whatsappAutomationsEnabled())");
  const operational = automation.indexOf(
    "whatsappConversationOperationallyEnabled",
  );
  const acknowledgement = automation.indexOf('"claim_deposit_proof_review"');

  assert.ok(operational > 0 && kill > 0 && acknowledgement > 0);
  // El kill switch y el control vivo de automatizaciones se evalúan antes.
  assert.ok(operational < acknowledgement);
  assert.ok(kill < acknowledgement);
});

test("el acuse se marca entregado sólo después del envío durable", () => {
  const automation = source("supabase/functions/whatsapp-automation/index.ts");
  const acknowledgement = automation.indexOf('"claim_deposit_proof_review"');
  const block = automation.slice(acknowledgement, acknowledgement + 3000);
  const sendIndex = block.indexOf("await send(");
  const markIndex = block.indexOf('"mark_deposit_proof_acknowledged"');

  assert.ok(sendIndex > 0, "el acuse se envía");
  assert.ok(markIndex > sendIndex, "marcar entregado va después de enviar");
  // Un envío fallido deja el acuse pendiente para el próximo intento.
  assert.match(block, /if \(acknowledged\.error\) throw acknowledged\.error/);
});
