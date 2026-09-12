import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const automation = readFileSync(
  resolve(process.cwd(), "supabase/functions/whatsapp-automation/index.ts"),
  "utf8",
);

test("precio y varios turnos a la vez interrumpen antes de cualquier reserva", () => {
  const multipleGuard = automation.indexOf(
    "requestsMultipleAppointments(inboundBody)",
  );
  const priceGuard = automation.indexOf("asksAboutPrice(inboundBody)");
  const stateMachine = automation.indexOf(
    'if (session.state === "collecting_patient_profile") {',
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

test("un turno para otra persona se reserva en su ficha, nunca en la de quien escribe", () => {
  const choosing = automation.indexOf(
    'if (session.state === "choosing_appointment_patient") {',
  );
  const dependentProfile = automation.indexOf(
    'if (session.state === "collecting_dependent_profile") {',
  );
  const structuredOwnIntake = automation.indexOf(
    "await persistProfileInput(null, true)",
  );
  const dependentCreation = automation.indexOf(
    '"create_whatsapp_automation_patient_appointment"',
  );

  assert.ok(automation.includes("requestsThirdPartyAppointment(inboundBody)"));
  // Los datos del tercero se procesan antes de que el alta estructurada propia
  // pueda escribirlos en la ficha del contacto.
  assert.ok(choosing > 0 && choosing < structuredOwnIntake);
  assert.ok(
    dependentProfile > choosing && dependentProfile < structuredOwnIntake,
  );
  assert.ok(dependentCreation > dependentProfile);
  assert.doesNotMatch(
    automation.slice(dependentProfile, structuredOwnIntake),
    /persistProfileInput\(|apply_whatsapp_automation_profile/,
  );
  assert.match(automation, /p_patient: dependentPatientPayload\(bookingFor\)/);
});

test("la persona a cargo sólo acompaña los pasos de la reserva", () => {
  const statesStart = automation.indexOf("const DEPENDENT_BOOKING_STATES");
  const states = automation.slice(
    statesStart,
    automation.indexOf("]);", statesStart),
  );

  assert.match(automation, /DEPENDENT_BOOKING_STATES\.has\(state\)/);
  assert.match(states, /selecting_service[\s\S]*confirming_appointment/);
  assert.doesNotMatch(states, /idle|waiting_deposit|human_handoff/);
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
    'if (session.state === "collecting_patient_profile") {',
  );

  assert.ok(infoGuard >= 0 && infoGuard < stateMachine);
  assert.match(
    automation.slice(infoGuard, stateMachine),
    /informationFlowResumePrompt\([\s\S]*session\.state,[\s\S]*session\.context,[\s\S]*\)[\s\S]*showClinicInfo\(resumePrompt\)/,
  );
  assert.doesNotMatch(
    automation.slice(infoGuard, stateMachine),
    /session\.state !== "reviewing_appointments"/,
  );
  assert.doesNotMatch(
    automation.slice(infoGuard, stateMachine),
    /inputValue\.startsWith\("flow:"\)/,
  );
  assert.match(
    automation,
    /locationPayload\([\s\S]*business_location: true[\s\S]*"business_location"/,
  );
});

test("ubicación automática envía texto breve, pin y continuación sin URL visible", () => {
  const infoStart = automation.indexOf("const showClinicInfo");
  const infoEnd = automation.indexOf(
    "const showAppointmentConfirmation",
    infoStart,
  );
  const infoFlow = automation.slice(infoStart, infoEnd);
  const deliveryStart = infoFlow.indexOf("const sendInformationAnswer");
  const deliveryEnd = infoFlow.indexOf(
    "const showConfiguredInfo",
    deliveryStart,
  );
  const delivery = infoFlow.slice(deliveryStart, deliveryEnd);

  assert.match(infoFlow, /conciseBusinessLocationMessage\(businessLocation\)/);
  assert.doesNotMatch(infoFlow, /Mapa:|share\.google/);
  assert.match(infoFlow, /business_maps_url: businessLocation\.mapsUrl/);
  assert.ok(
    delivery.indexOf("sendConfiguredLocation()") >
      delivery.indexOf("textPayload(locationAnswer)"),
  );
  assert.ok(
    delivery.indexOf("textPayload(answer)") >
      delivery.indexOf("sendConfiguredLocation()"),
  );
  assert.ok(
    delivery.indexOf("sendInformationContinuation()") >
      delivery.indexOf("sendConfiguredLocation()"),
  );
  assert.match(
    infoFlow,
    /infoIntent === "location" \|\|[\s\S]*infoIntent === "business_info"[\s\S]*showConfiguredInfo\(\)/,
  );
});

test("información fuera de flujo ofrece sólo turno u otra consulta", () => {
  const infoStart = automation.indexOf("const showClinicInfo");
  const infoEnd = automation.indexOf(
    "const showAppointmentConfirmation",
    infoStart,
  );
  const infoFlow = automation.slice(infoStart, infoEnd);

  assert.match(infoFlow, /INFORMATION_FOLLOW_UP_BUTTONS/);
  assert.doesNotMatch(infoFlow, /flow:menu|Menú principal/);
  assert.match(
    infoFlow,
    /if \(resumePrompt\)[\s\S]*sendInformationResume\(\)[\s\S]*else[\s\S]*buttonsPayload/,
  );
  assert.match(infoFlow, /textPayload\(resumePrompt\)/);
});

test("la reanudación repone las listas que no aceptan una respuesta textual", () => {
  const infoStart = automation.indexOf("const showClinicInfo");
  const infoEnd = automation.indexOf(
    "const showAppointmentConfirmation",
    infoStart,
  );
  const infoFlow = automation.slice(infoStart, infoEnd);
  const resumeStart = infoFlow.indexOf("const sendInformationResume");
  const resumeEnd = infoFlow.indexOf(
    "const sendInformationContinuation",
    resumeStart,
  );
  const resumeFlow = infoFlow.slice(resumeStart, resumeEnd);

  assert.match(resumeFlow, /selecting_appointment_to_reschedule/);
  assert.match(resumeFlow, /selecting_appointment_to_cancel/);
  assert.match(resumeFlow, /listPayload\(resumePrompt, "Elegir turno", rows\)/);
  assert.doesNotMatch(resumeFlow, /showMainMenu|flow:menu/);
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
  assert.match(waitingFlow, /Hablar con (?:la )?secretaria/);
  assert.match(waitingFlow, /SECRETARY_REPLY_ID/);
  assert.match(waitingFlow, /await handoff/);
});

test("el WhatsApp de origen se usa como contacto sin pedir confirmarlo", () => {
  assert.match(
    automation,
    /typeof contact\.phone_e164 === "string"[\s\S]{0,160}\^\\\+\[1-9\]\[0-9\]\{7,14\}\$/,
  );
});
