import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

test("Settings reconoce la selección pendiente sin cortar la conexión activa", () => {
  const page = source("src/routes/app/settings/index.tsx");

  assert.match(page, /googleResult === "selection_required"/);
  assert.match(
    page,
    /data\.selectionPending === true \|\|\s*data\.status === "selection_required"/,
  );
  assert.match(page, /googleCalendar\.selectionPending && state\.isAdmin/);
  assert.match(
    page,
    /\) : googleCalendar\.connected \|\|\s*googleCalendar\.syncStatus === "reconnect" \? \(/,
    "la selección pendiente debe evaluarse antes de la conexión activa",
  );
});

test("Settings lista y confirma calendarios con el contrato ADMIN", () => {
  const page = source("src/routes/app/settings/index.tsx");
  const loaderStart = page.indexOf("const loadSelectableGoogleCalendars");
  const loaderEnd = page.indexOf("useVisibleTask$", loaderStart);
  const loader = page.slice(loaderStart, loaderEnd);
  const selectionStart = page.indexOf(
    'googleCalendar.action = "select-calendar"',
  );
  const selectionEnd = page.indexOf("} catch {", selectionStart);
  const selection = page.slice(selectionStart, selectionEnd);

  assert.ok(loaderStart >= 0 && loaderEnd > loaderStart);
  assert.match(loader, /!state\.isAdmin/);
  assert.match(loader, /!googleCalendar\.selectionPending/);
  assert.match(loader, /"google-calendar-selection",\s*\{ method: "GET" \}/);
  assert.match(loader, /data\?\.selectionRequired === false/);
  assert.match(loader, /googleCalendar\.selectionPending = false/);
  assert.match(loader, /await loadGoogleCalendarStatus\(\)/);

  assert.ok(selectionStart >= 0 && selectionEnd > selectionStart);
  assert.match(selection, /"google-calendar-selection"/);
  assert.match(selection, /method: "POST"/);
  assert.match(
    selection,
    /body:\s*\{\s*calendarId:\s*googleCalendar\.selectedCalendarId/,
  );
  assert.match(selection, /data\?\.selected !== true/);
  assert.match(selection, /data\?\.connected !== true/);
  assert.match(selection, /await loadGoogleCalendarStatus\(\)/);

  assert.match(page, /const cancelGoogleCalendarSelection/);
  assert.match(page, /"google-calendar-selection",\s*\{ method: "DELETE" \}/);
  assert.match(page, /data\?\.cancelled !== true/);
  assert.match(page, /"Elegir otra cuenta"/);
});

test("Settings traduce fallas de selección sin mostrar detalles arbitrarios", () => {
  const page = source("src/routes/app/settings/index.tsx");

  assert.match(page, /function googleCalendarFunctionErrorCode/);
  assert.match(page, /context instanceof Response/);
  assert.match(page, /context\.clone\(\)\.json\(\)/);
  assert.match(page, /GOOGLE_CALENDAR_TIMEZONE_MISMATCH/);
  assert.match(page, /GOOGLE_CALENDAR_EVENTS_ACCESS_REQUIRED/);
  assert.match(page, /GOOGLE_CALENDAR_DISCONNECT_REQUIRED/);
  assert.match(page, /Primero desconectá la cuenta actual/);
  assert.match(page, /aceptá ambos permisos/);
  assert.match(page, /failureCode \|\|/);
});

test("Settings refleja el alcance confirmed y una revocación no confirmada", () => {
  const page = source("src/routes/app/settings/index.tsx");

  assert.match(page, /turnos confirmados y sus cambios/i);
  assert.match(page, /Los turnos aún\s+programados no se envían/);
  assert.match(page, /data\?\.disconnected !== true/);
  assert.match(page, /data\.remoteRevocationConfirmed === true/);
  assert.match(page, /Google no confirmó la revocación/);
});

test("la primera importación exige un preview completo y compatible", () => {
  const page = source("src/routes/app/settings/index.tsx");

  assert.match(page, /function parseCalendarImportPreview/);
  assert.match(page, /Number\.isSafeInteger\(candidate\)/);
  assert.match(page, /response\.mutated !== false/);
  assert.match(page, /googleCalendar\.preview = null;\s*try \{/);
  assert.match(page, /googleCalendar\.preview = preview/);
  assert.match(page, /!googleCalendar\.preview \|\|/);
  assert.match(page, /googleCalendar\.preview\.truncated \|\|/);
  assert.match(page, /googleCalendar\.preview\.unsupportedEvents > 0/);
  assert.match(page, /No habilites la importación/);
});

test("reconnect_required conserva la acción de desconexión para cambiar de cuenta", () => {
  const page = source("src/routes/app/settings/index.tsx");

  assert.match(
    page,
    /googleCalendar\.connected \|\|\s*googleCalendar\.syncStatus === "reconnect"/,
  );
  assert.match(page, /:\s*"Desconectar"/);
});

test("metadata_changed sólo permite restaurar desde la agenda", () => {
  const page = source("src/routes/app/settings/index.tsx");
  const conflictsStart = page.indexOf('class="calendar-conflicts"');
  const conflictsEnd = page.indexOf("{state.isAdmin && (", conflictsStart);
  const conflicts = page.slice(conflictsStart, conflictsEnd);

  assert.ok(conflictsStart >= 0 && conflictsEnd > conflictsStart);
  assert.match(conflicts, /conflict\.kind === "metadata_changed"/);
  assert.match(conflicts, /Se modificaron datos del evento en Google/);
  assert.match(conflicts, /Restaurar desde la agenda/);
  assert.match(
    conflicts,
    /\{conflict\.kind !== "metadata_changed" && \(\s*<button/,
  );
});

test("la elección muestra sólo nombre, principal y zona horaria", () => {
  const page = source("src/routes/app/settings/index.tsx");
  const styles = source("src/global.css");
  const cardStart = page.indexOf(
    'class="google-calendar-card google-calendar-selection"',
  );
  const cardEnd = page.indexOf(") : googleCalendar.connected ||", cardStart);
  const card = page.slice(cardStart, cardEnd);

  assert.ok(cardStart >= 0 && cardEnd > cardStart);
  assert.match(card, /<strong>\{calendar\.name\}<\/strong>/);
  assert.match(card, /calendar\.primary/);
  assert.match(card, /calendar\.timeZone/);
  assert.match(card, />Principal<\/small>/);
  assert.match(card, /calendar\.timeZone !== state\.timezone/);
  assert.match(card, /No coincide con la agenda/);
  assert.doesNotMatch(card, /value=\{calendar\.id\}/);
  assert.doesNotMatch(card, />\s*\{calendar\.id\}\s*</);
  assert.doesNotMatch(card, /googleCalendar\.email/);
  assert.match(styles, /\.google-calendar-choice-list/);
  assert.match(styles, /\.google-calendar-choice-name/);
});
