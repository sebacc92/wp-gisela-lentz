import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

test("la ruta Manual y sus enlaces conservan el control de acceso ADMIN", () => {
  const page = source("src/routes/app/manual/index.tsx");
  const appLayout = source("src/routes/app/layout.tsx");
  const navigation = source("src/components/app/AppNavigation.tsx");
  const contextualHelp = source("src/components/app/ManualHelpLink.tsx");

  assert.match(page, /isAdminProfile\(profile\)/);
  assert.match(page, /access\.allowed = true/);
  assert.match(page, /!access\.allowed/);
  assert.match(navigation, /key: "manual"/);
  assert.match(navigation, /adminOnly: true/);
  assert.match(appLayout, /select\("full_name,role,active"\)/);
  assert.match(appLayout, /appUser\.isAdmin = isAdminProfile\(profile\)/);
  assert.match(navigation, /!item\.adminOnly \|\| appUser\.isAdmin/);
  assert.match(navigation, /"odontogram", "settings", "manual"/);
  assert.match(contextualHelp, /if \(!appUser\.isAdmin\) return null/);
});

test("el Manual integra estado simple, enlaces internos y diseño móvil", () => {
  const page = source("src/routes/app/manual/index.tsx");
  const content = source("src/components/manual/ManualContent.tsx");
  const systemStatus = source("src/components/manual/SystemStatus.tsx");
  const styles = source("src/global.css");
  const inbox = source("src/components/inbox/ConversationList.tsx");

  assert.match(page, /<ManualContent/);
  assert.match(page, /action: "manual_status"/);
  assert.match(page, /google-calendar-status/);
  assert.match(page, /lastWebhookChecked/);
  assert.equal(page.includes('from("webhook_events")'), false);
  assert.equal(page.includes("whatsapp-health"), false);
  assert.match(page, /\.\.\.emptySystemStatus\(\)/);
  assert.match(content, /<SystemStatus/);
  assert.match(content, /id="whatsapp"/);
  assert.match(content, /id="turnos"/);
  assert.match(systemStatus, /id="estado-del-sistema"/);
  assert.match(inbox, /section="whatsapp"/);
  assert.match(styles, /@media \(max-width: 680px\)/);
  assert.match(styles, /\.manual-toc/);
  assert.match(styles, /\.system-status-grid/);
});

test("la UI del Manual no incorpora identificadores ni valores de credenciales", () => {
  const publicManual = [
    source("src/components/manual/ManualContent.tsx"),
    source("src/components/manual/SystemStatus.tsx"),
    source("src/routes/app/manual/index.tsx"),
  ].join("\n");

  for (const forbidden of [
    "META_APP_SECRET",
    "META_WEBHOOK_VERIFY_TOKEN",
    "WHATSAPP_ACCESS_TOKEN",
    "businessAccessToken",
    "phoneNumberId",
    "wabaId",
    "vault",
  ]) {
    assert.equal(publicManual.includes(forbidden), false, forbidden);
  }
  assert.doesNotMatch(publicManual, /\bBearer\s+[A-Za-z0-9._-]{12,}/);
  assert.doesNotMatch(publicManual, /\beyJ[A-Za-z0-9_-]{12,}/);
});
