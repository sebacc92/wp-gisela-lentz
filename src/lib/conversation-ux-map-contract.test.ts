import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const automation = readFileSync(
  resolve(process.cwd(), "supabase/functions/whatsapp-automation/index.ts"),
  "utf8",
);

test("precio y turnos para terceros interrumpen antes de cualquier reserva", () => {
  const multipleGuard = automation.indexOf(
    "requestsMultipleAppointments(inboundBody)",
  );
  const priceGuard = automation.indexOf("asksAboutPrice(inboundBody)");
  const stateMachine = automation.indexOf(
    'session.state === "collecting_patient_profile"',
  );
  const appointmentCreation = automation.indexOf(
    '"create_whatsapp_automation_appointment"',
  );

  assert.ok(multipleGuard >= 0);
  assert.ok(priceGuard > multipleGuard);
  assert.ok(stateMachine > priceGuard);
  assert.ok(appointmentCreation > stateMachine);
  assert.match(
    automation.slice(multipleGuard, stateMachine),
    /MULTIPLE_APPOINTMENTS_REQUESTED[\s\S]*PRICE_QUESTION/,
  );
});

test("un saludo nuevo muestra opciones y no inicia el alta por defecto", () => {
  const idleStart = automation.indexOf('if (session.state === "idle")');
  const idleEnd = automation.indexOf(
    'session.state === "selecting_service"',
    idleStart,
  );
  const idleFlow = automation.slice(idleStart, idleEnd);

  assert.match(idleFlow, /freshSession[\s\S]*showMainMenu\(welcomeMessage/);
  assert.doesNotMatch(idleFlow, /startNewAppointmentFlow\(\)/);
});

test("las consultas laterales de información preservan el paso en curso", () => {
  const infoGuard = automation.indexOf('requestedIntent === "info"');
  const stateMachine = automation.indexOf(
    'session.state === "collecting_patient_profile"',
  );

  assert.ok(infoGuard >= 0 && infoGuard < stateMachine);
  assert.match(
    automation.slice(infoGuard, stateMachine),
    /resumeCurrentFlow[\s\S]*showClinicInfo\(resumeCurrentFlow\)/,
  );
  assert.doesNotMatch(
    automation.slice(infoGuard, stateMachine),
    /session\.state !== "reviewing_appointments"/,
  );
  assert.match(
    automation,
    /locationPayload\([\s\S]*business_location: true[\s\S]*"business_location"/,
  );
});

test("la espera de seña ofrece ayuda una vez y luego deriva", () => {
  const waitingStart = automation.lastIndexOf(
    'session.state === "waiting_deposit"',
  );
  const waitingEnd = automation.indexOf("} else {", waitingStart + 60);
  const waitingFlow = automation.slice(
    waitingStart,
    waitingEnd > waitingStart ? waitingEnd + 2000 : undefined,
  );

  assert.match(waitingFlow, /depositHelpShown/);
  assert.match(waitingFlow, /deposit:ack/);
  assert.match(waitingFlow, /deposit:cancel/);
  assert.match(waitingFlow, /Hablar con persona/);
  assert.match(waitingFlow, /await handoff/);
});

test("el WhatsApp de origen se usa como contacto sin pedir confirmarlo", () => {
  assert.match(
    automation,
    /typeof contact\.phone_e164 === "string"[\s\S]{0,160}\^\\\+\[1-9\]\[0-9\]\{7,14\}\$/,
  );
  assert.match(automation, /profile:coverage:other/);
  assert.match(automation, /reason: "OTHER_COVERAGE"/);
});
