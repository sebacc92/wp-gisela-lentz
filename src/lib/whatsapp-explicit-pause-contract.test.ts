import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

test("a web reply does not switch the conversation to manual", () => {
  const inbox = source("src/routes/app/inbox/index.tsx");
  const sendStart = inbox.indexOf("onSend$={async");
  const sendEnd = inbox.indexOf("onNotice$=", sendStart);
  assert.ok(sendStart >= 0 && sendEnd > sendStart);

  const sendHandler = inbox.slice(sendStart, sendEnd);
  assert.doesNotMatch(sendHandler, /automationMode\s*=\s*["']manual["']/);
  assert.match(sendHandler, /whatsappSendFailureNotice/);
});

test("marking a conversation pending does not pause its automation", () => {
  const inbox = source("src/routes/app/inbox/index.tsx");
  const handlerStart = inbox.indexOf("onTogglePending$={async");
  const handlerEnd = inbox.indexOf("onToggleClosed$=", handlerStart);
  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);

  const handler = inbox.slice(handlerStart, handlerEnd);
  assert.doesNotMatch(handler, /automation_mode/);
  assert.doesNotMatch(handler, /automationMode\s*=/);
  assert.match(handler, /needs_human:\s*nextNeedsHuman/);
});

test("the Edge sender audits an operator reply without persisting manual mode", () => {
  const sender = source("supabase/functions/whatsapp-send/index.ts");
  assert.match(sender, /action: "message\.operator_sent"/);
  assert.doesNotMatch(sender, /action: "message\.manual_sent"/);
  assert.doesNotMatch(sender, /automation_mode:\s*"manual"/);
});

test("the shared Graph path no longer infers a manual handoff", () => {
  const shared = source("supabase/functions/_shared/whatsapp.ts");
  assert.doesNotMatch(shared, /pauseAutomationForManualDispatch/);
  assert.match(shared, /AUTOMATION_SUPERSEDED_BY_HUMAN_REPLY/);
});

test("the durable message trigger no longer treats sent_by as a pause", () => {
  const migration = source(
    "supabase/migrations/20260828050000_whatsapp_operator_send_preserves_automation.sql",
  );
  assert.match(migration, /sync_conversation_after_message/);
  assert.doesNotMatch(migration, /automation_mode\s*=/);
  assert.doesNotMatch(migration, /needs_human\s*=/);
});
