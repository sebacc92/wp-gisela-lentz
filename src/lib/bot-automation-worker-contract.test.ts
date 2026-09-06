import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

test("el worker consulta el gate operativo vivo antes de procesar mensajes", () => {
  const worker = readFileSync(
    resolve(process.cwd(), "supabase/functions/whatsapp-automation/index.ts"),
    "utf8",
  );
  const snapshot = worker.indexOf(
    "const appSettings = execution.settings_snapshot;",
  );
  const guard = worker.indexOf(
    "await whatsappConversationOperationallyEnabled({",
    snapshot,
  );
  const conversationBinding = worker.indexOf(
    "conversationId: conversation.id",
    guard,
  );
  const disabled = worker.indexOf('reason: "AUTOMATIONS_DISABLED"', guard);
  const serverGuard = worker.indexOf(
    "if (!whatsappAutomationsEnabled())",
    disabled,
  );
  const recipient = worker.indexOf("const automationRecipient", serverGuard);

  assert.ok(snapshot >= 0, "the claimed execution must expose its settings");
  assert.ok(guard > snapshot, "the live database gate must guard the worker");
  assert.ok(
    conversationBinding > guard,
    "the operational decision must be bound to the claimed conversation",
  );
  assert.ok(disabled > guard, "the disabled outcome must be persisted");
  assert.ok(
    serverGuard > disabled,
    "the server kill switch must remain active",
  );
  assert.ok(recipient > serverGuard, "both guards must run before a recipient");
});

test("reservar, reprogramar y confirmar fallan cerrado ante Calendar", () => {
  const worker = readFileSync(
    resolve(process.cwd(), "supabase/functions/whatsapp-automation/index.ts"),
    "utf8",
  );

  assert.match(worker, /refreshCalendarAvailabilityBeforeBooking/);
  const createCall = worker.indexOf('"create_whatsapp_automation_appointment"');
  const createRefresh = worker.lastIndexOf(
    "await refreshCalendarAvailability()",
    createCall,
  );
  const createResultGuard = worker.indexOf(
    'effectError === "CALENDAR_AVAILABILITY_UNAVAILABLE"',
    createCall,
  );
  const createCommit = worker.indexOf('type: "create"', createCall);
  assert.ok(createRefresh >= 0 && createRefresh < createCall);
  assert.ok(
    createResultGuard > createCall && createResultGuard < createCommit,
    "a rejected Calendar create must hand off before any domain success",
  );

  const rescheduleCall = worker.indexOf(
    '"reschedule_whatsapp_automation_appointment"',
  );
  const rescheduleRefresh = worker.lastIndexOf(
    "await refreshCalendarAvailability()",
    rescheduleCall,
  );
  const rescheduleCommit = worker.indexOf('type: "reschedule"', rescheduleCall);
  const rescheduleResultGuard = worker.indexOf(
    'effectError === "CALENDAR_AVAILABILITY_UNAVAILABLE"',
    rescheduleCall,
  );
  assert.ok(rescheduleRefresh >= 0 && rescheduleRefresh < rescheduleCall);
  assert.ok(
    rescheduleResultGuard > rescheduleCall &&
      rescheduleResultGuard < rescheduleCommit,
    "a durable Calendar rejection must be handled before reporting success",
  );
  assert.match(
    worker.slice(createRefresh, createCommit),
    /reason: "CALENDAR_AVAILABILITY_UNAVAILABLE"/,
  );
  assert.match(
    worker.slice(rescheduleRefresh, rescheduleCommit),
    /Tu turno original sigue reservado/,
  );

  const proofCall = worker.indexOf('"process_automated_deposit_proof"');
  const proofRefresh = worker.lastIndexOf(
    "await refreshCalendarAvailability()",
    proofCall,
  );
  const proofPayload = worker.slice(proofRefresh, proofCall + 1400);
  assert.ok(proofRefresh >= 0 && proofRefresh < proofCall);
  assert.match(proofPayload, /calendarAvailabilityVerified/);
  assert.match(
    proofPayload,
    /p_auto_approve:\s*validation\.approved && calendarAvailabilityVerified/,
  );
});
