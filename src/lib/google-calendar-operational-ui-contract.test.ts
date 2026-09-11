import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

test("Inicio y Agenda reutilizan el mismo resumen operativo", () => {
  const home = source("src/routes/app/index.tsx");
  const agenda = source("src/routes/app/appointments/index.tsx");

  assert.match(home, /<GoogleCalendarStatusBlock variant="home" \/>/);
  // La agenda le avisa además que ya lista los conflictos: sigue siendo el
  // mismo bloque y la misma variante, con una prop más.
  assert.match(
    agenda,
    /<GoogleCalendarStatusBlock\s+variant="agenda"[\s\S]*?\/>/,
  );
  assert.match(
    agenda,
    /conflictsHandledInPage=\{state\.conflicts\.length > 0\}/,
  );
});

test("consultar el bloque no dispara sincronización ni cron", () => {
  const block = source("src/components/app/GoogleCalendarStatusBlock.tsx");
  const visibleTaskStart = block.indexOf("useVisibleTask$");
  const syncHandlerStart = block.indexOf("const synchronize = $");
  const visibleTask = block.slice(visibleTaskStart, syncHandlerStart);

  assert.ok(visibleTaskStart >= 0 && syncHandlerStart > visibleTaskStart);
  assert.match(visibleTask, /loadStatus\(\)/);
  assert.doesNotMatch(visibleTask, /process-calendar-sync/);
  assert.match(block, /"google-calendar-status"/);
  assert.equal(block.match(/"process-calendar-sync"/g)?.length, 1);
  assert.match(block, /body: \{ mode: "manual" \}/);
});

test("Sincronizar ahora exige ADMIN y evita doble envío local", () => {
  const block = source("src/components/app/GoogleCalendarStatusBlock.tsx");

  assert.match(block, /useContext\(APP_USER_CONTEXT\)/);
  assert.match(block, /!appUser\.isAdmin/);
  assert.match(block, /state\.syncing \|\|/);
  assert.match(block, /current\.firstImportApproved/);
  assert.match(block, /current\.inboundSyncState/);
  assert.match(block, /current\.connected/);
  assert.match(
    block,
    /disabled=\{!canSynchronize \|\| state\.loading \|\| state\.syncing\}/,
  );
  assert.match(block, /appUser\.isAdmin && hasConflicts \?/);
  assert.match(block, /: appUser\.isAdmin \? \(/);
});

test("los conflictos llevan a la decisión pendiente en vez de ofrecer otra sincronización", () => {
  const block = source("src/components/app/GoogleCalendarStatusBlock.tsx");
  const settings = source("src/components/settings/GoogleCalendarSettings.tsx");

  assert.match(block, /const hasConflicts =/);
  assert.match(
    block,
    /href="\/app\/settings\?section=google#google-calendar-conflicts"/,
  );
  assert.match(block, />\s*Revisar cambios\s*<\/Link>/);
  assert.match(settings, /id="google-calendar-conflicts"/);
});

test("el resumen muestra revisión exitosa y nunca identidad de Calendar", () => {
  const block = source("src/components/app/GoogleCalendarStatusBlock.tsx");
  const parser = source("src/lib/google-calendar-operational-status.ts");
  const styles = source("src/global.css");

  assert.match(block, /Última revisión exitosa/);
  assert.match(block, /lastSuccessfulReviewAt/);
  assert.match(block, /Automatización/);
  assert.match(block, /conflicto\(s\)/);
  assert.match(parser, /automationActive: source\.automationActive === true/);
  assert.doesNotMatch(parser, /calendarName|email|eventSummary|patient/i);
  assert.match(styles, /\.calendar-operational-status/);
  assert.match(
    styles,
    /@media \(max-width: 680px\)[\s\S]*?\.calendar-operational-status/,
  );
});
