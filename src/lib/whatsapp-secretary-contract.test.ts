import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

test("la opción de secretaria usa el handoff causal existente", () => {
  const automation = source("supabase/functions/whatsapp-automation/index.ts");
  const handoffStart = automation.indexOf("const handoff = async (");
  const handoffEnd = automation.indexOf(
    "const respondToDepositProofResult",
    handoffStart,
  );
  const handoff = automation.slice(handoffStart, handoffEnd);
  const secretaryStart = automation.indexOf(
    "if (isSecretaryRequest(inputValue))",
  );
  const secretaryEnd = automation.indexOf(
    "let requestedIntent",
    secretaryStart,
  );
  const secretary = automation.slice(secretaryStart, secretaryEnd);

  assert.ok(handoffStart >= 0 && handoffEnd > handoffStart);
  assert.ok(secretaryStart >= 0 && secretaryEnd > secretaryStart);
  assert.ok(
    handoff.indexOf("claimInboundHandoff(client, inbound.id)") <
      handoff.indexOf("await send("),
  );
  assert.match(handoff, /\{ human_handoff: true \}[\s\S]*"handoff"/);
  assert.match(
    secretary,
    /await handoff\("", \{\}, SECRETARY_HANDOFF_MESSAGE\)/,
  );
  assert.match(secretary, /reason: "SECRETARY_REQUESTED"/);
  assert.doesNotMatch(secretary, /\.from\("conversations"\)|\.update\(/);
});

test("el modo manual corta la automatización antes de interpretar otro mensaje", () => {
  const automation = source("supabase/functions/whatsapp-automation/index.ts");
  const manualGate = automation.indexOf(
    'if (conversation.automation_mode !== "auto")',
  );
  const secretaryBranch = automation.indexOf(
    "if (isSecretaryRequest(inputValue))",
  );
  const outOfHoursGate = automation.indexOf(
    "freshSession &&\n      appSettings?.out_of_hours_enabled === true",
  );

  assert.ok(manualGate >= 0);
  assert.ok(secretaryBranch > manualGate);
  assert.ok(outOfHoursGate > secretaryBranch);
  assert.match(
    automation.slice(manualGate, outOfHoursGate),
    /return await finish\(\{ ignored: true \}\)/,
  );
});

test("la extensión del menú queda aislada de whatsapp-webhook", () => {
  const automation = source("supabase/functions/whatsapp-automation/index.ts");
  const webhook = source("supabase/functions/whatsapp-webhook/index.ts");

  assert.match(automation, /from "\.\/flow-options\.ts"/);
  assert.match(
    automation,
    /listPayload\(message, "Ver opciones", APPOINTMENT_MAIN_MENU_OPTIONS\)/,
  );
  assert.doesNotMatch(webhook, /flow-options|SECRETARY_REPLY_ID/);
});
