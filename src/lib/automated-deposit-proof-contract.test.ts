import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

test("la automatización procesa el comprobante con una policy versionada", () => {
  const automation = source("supabase/functions/whatsapp-automation/index.ts");

  assert.match(automation, /process_automated_deposit_proof/);
  assert.match(automation, /deposit-proof-basic\/v1/);
  assert.match(automation, /proof\.status === "confirmed"/);
  assert.match(automation, /proof\.status === "superseded"/);
  assert.match(automation, /reviewReasons: string\[\]/);
  assert.match(automation, /deposit_validation_reasons: proof\.reviewReasons/);
  assert.match(automation, /necesitamos revisar el estado actual del turno/);
  assert.match(automation, /deposit_auto_confirmed: automaticallyConfirmed/);
  assert.match(automation, /validRenderedConfirmation/);
  assert.match(
    automation,
    /!\/\\\{\[A-Za-z\]\[A-Za-z0-9_\]\*\\\}\/\.test\(renderedConfirmationMessage\)/,
  );
  assert.match(automation, /defaultConfirmationMessage/);
  assert.doesNotMatch(automation, /Recibí la seña y confirmé/);
  assert.match(automation, /depositProofReviewMessage/);
  assert.match(automation, /route_automated_deposit_proof_to_review/);
  assert.match(automation, /priorDepositProofResult === null/);
  assert.match(
    automation,
    /return await respondToDepositProofResult\(priorDepositProofResult\)/,
  );
  assert.match(automation, /p_lease_token: proofLease\.leaseToken/);
  assert.match(automation, /"deposit_confirmation"/);
  assert.match(automation, /proof\.appointmentId/);
  assert.match(automation, /deposit_expected_amount_ars/);
  assert.match(automation, /deposit_expected_alias/);
  assert.match(automation, /deposit_expected_holder/);
});

test("el comprobante sigue accesible después de una confirmación automática", () => {
  const data = source("src/lib/supabase/data.ts");
  const appointments = source("src/routes/app/appointments/index.tsx");

  assert.match(data, /deposit_confirmation_actor/);
  assert.match(data, /deposit_confirmation_policy_version/);
  assert.match(
    appointments,
    /selectedAppointment\.depositProofMessageId\s*&&\s*\(/,
  );
  assert.match(appointments, /Revisar comprobante/);
  assert.match(appointments, /Confirmación de seña/);
});

test("un archivo sólo sale hacia IA con una pre-reserva y switches vivos", () => {
  const automation = source("supabase/functions/whatsapp-automation/index.ts");
  const contextGuard = automation.indexOf(
    "const depositProofMediaContextReady",
  );
  const durableRecall = automation.indexOf(
    '"recall_whatsapp_automation_decision"',
    contextGuard,
  );
  const liveBeforeDownload = automation.indexOf(
    "await readLiveMediaOpenAIEnabled()",
    durableRecall,
  );
  const download = automation.indexOf("downloadInboundWhatsAppMedia({");
  const liveRecheck = automation.indexOf(
    "await readLiveMediaOpenAIEnabled()",
    download,
  );
  const firstMediaRequest = Math.min(
    automation.indexOf("requestAudioTranscription({", liveRecheck),
    automation.indexOf("requestDepositProofReading({", liveRecheck),
  );

  assert.ok(contextGuard >= 0 && contextGuard < download);
  assert.ok(
    durableRecall > contextGuard &&
      liveBeforeDownload > durableRecall &&
      liveBeforeDownload < download,
  );
  assert.match(
    automation.slice(contextGuard, download),
    /session\.state === "waiting_deposit"/,
  );
  assert.match(
    automation.slice(contextGuard, download),
    /snapshotAppointmentId !== null/,
  );
  assert.match(
    automation.slice(contextGuard, durableRecall),
    /mediaDecisionEligible\s*=\s*priorDepositProofResult === null &&\s*mediaMessage &&\s*mediaContextReady/,
  );
  assert.doesNotMatch(
    automation.slice(contextGuard, durableRecall),
    /mediaDecisionEligible\s*=[\s\S]{0,120}snapshotMediaEnabled/,
  );
  assert.match(
    automation.slice(durableRecall, download),
    /!snapshotMediaEnabled \|\|\s*!\(await readLiveMediaOpenAIEnabled\(\)\)/,
  );
  assert.match(
    automation,
    /\.select\("ai_enabled,ai_media_enabled,ai_model"\)/,
  );
  assert.ok(liveRecheck > download && liveRecheck < firstMediaRequest);
  assert.match(automation, /OPENAI_MEDIA_CONTROL_UNAVAILABLE/);
  assert.match(automation, /OPENAI_MEDIA_DISABLED_LIVE/);
});

test("un adjunto opaco despacha una respuesta aun con la IA apagada", () => {
  const incoming = source("supabase/functions/_shared/incoming-message.ts");

  assert.match(
    incoming,
    /input\.readableMedia \|\|\s*input\.humanReviewPauseOwned/,
  );
  assert.match(incoming, /shouldDispatchIncomingAutomation\(\{/);
});

test("una nota transcripta reevalúa urgencias y contenido clínico", () => {
  const automation = source("supabase/functions/whatsapp-automation/index.ts");

  assert.match(
    automation,
    /const transcribedMessage: NormalizedIncomingMessage/,
  );
  assert.match(
    automation,
    /transcribedAudioPriority = requiresPriority\(transcribedMessage\)/,
  );
  assert.match(
    automation,
    /transcribedAudioNeedsHuman = requiresHumanReview\(transcribedMessage\)/,
  );
  assert.match(
    automation,
    /conversation\.priority === true \|\| transcribedAudioPriority/,
  );
  assert.match(automation, /if \(transcribedAudioNeedsHuman\)/);
  assert.match(
    automation,
    /whatsappConsentDecisionFromText\(inboundBody\) === "opt_out"/,
  );
  assert.match(automation, /record_transcribed_whatsapp_opt_out/);
});

test("reprogramar una pre-reserva mantiene la espera del comprobante", () => {
  const automation = source("supabase/functions/whatsapp-automation/index.ts");
  const rescheduleStart = automation.indexOf(
    'session.state === "confirming_new_slot"',
  );
  const rescheduleEnd = automation.indexOf(
    'session.state === "selecting_appointment_to_cancel"',
    rescheduleStart,
  );
  assert.ok(rescheduleStart >= 0 && rescheduleEnd > rescheduleStart);

  const flow = automation.slice(rescheduleStart, rescheduleEnd);
  assert.match(flow, /depositStatus === "pending"/);
  assert.match(flow, /await saveSession\(\s*"waiting_deposit"/);
  assert.match(flow, /\{ appointmentId \}/);
  assert.match(flow, /La pre-reserva sigue esperando la seña/);
});
