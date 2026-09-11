import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

/**
 * Colapsa los saltos de línea y la sangría del JSX. Estos contratos fijan el
 * texto que lee Gisela, no cómo lo reparte el formateador: sin esto, mover una
 * sección de archivo o reformatear una frase rompería la prueba sin que haya
 * cambiado una sola palabra.
 */
function prose(value: string): string {
  return value.replace(/\s+/g, " ");
}

test("Settings reconoce la selección pendiente sin cortar la conexión activa", () => {
  const page = source("src/components/settings/GoogleCalendarSettings.tsx");

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
  const page = source("src/components/settings/GoogleCalendarSettings.tsx");
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
  const page = source("src/components/settings/GoogleCalendarSettings.tsx");

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

test("Settings refleja el alcance sincronizado y una revocación no confirmada", () => {
  const page = source("src/components/settings/GoogleCalendarSettings.tsx");

  assert.match(page, /pre-reservas vigentes/i);
  assert.match(page, /turnos confirmados y sus cambios/i);
  assert.match(page, /todavía no se hacen escrituras automáticas/i);
  assert.match(page, /data\?\.disconnected !== true/);
  assert.match(page, /data\.remoteRevocationConfirmed === true/);
  assert.match(page, /Google no confirmó la revocación/);
});

test("la primera importación exige un preview completo y compatible", () => {
  const page = source("src/components/settings/GoogleCalendarSettings.tsx");
  const parser = source("src/lib/google-calendar-import-preview.ts");

  assert.match(page, /parseCalendarImportPreview/);
  assert.match(parser, /Number\.isSafeInteger\(candidate\)/);
  assert.match(parser, /response\.mutated !== false/);
  assert.match(parser, /legacyManagedEvents/);
  assert.match(page, /googleCalendar\.preview = null;\s*try \{/);
  assert.match(page, /googleCalendar\.preview = preview/);
  assert.match(page, /!googleCalendar\.preview \|\|/);
  assert.match(page, /googleCalendar\.preview\.truncated \|\|/);
  assert.match(page, /googleCalendar\.preview\.unsupportedEvents > 0/);
  assert.match(page, /No habilites la importación/);
  assert.match(page, /1\. Ver qué hay en Google/);
  assert.match(page, /2\. Primero revisá el calendario/);
  assert.match(page, /2\. Habilitar e importar/);
});

test("el preview separa alcance, series, ocurrencias y bloqueos", () => {
  const page = source("src/components/settings/GoogleCalendarSettings.tsx");

  assert.match(page, /googleCalendar\.preview\.managedEvents/);
  assert.match(prose(page), /administrados por esta versión de la agenda/);
  assert.match(page, /googleCalendar\.preview\.externalEvents/);
  assert.match(
    prose(page),
    /eventos u ocurrencias externos dentro del horizonte revisado/,
  );
  assert.match(page, /googleCalendar\.preview\s*\.legacyManagedEvents/);
  assert.match(prose(page), /integración anterior sin un turno asociado/);
  assert.match(page, /googleCalendar\.preview\.wouldBecomeBlocks/);
  assert.match(prose(page), /ocupaciones pasarían a ser bloqueos de agenda/);
  assert.match(page, /googleCalendar\.preview\.recurringSeries/);
  assert.match(page, /googleCalendar\.preview\s*\.recurringOccurrences/);
  assert.match(
    page,
    /googleCalendar\.preview\s*\.cancelledRecurringOccurrences/,
  );
  assert.match(page, /googleCalendar\.preview\.allDayEvents/);
  assert.match(page, /googleCalendar\.preview\.freeEventsIgnored/);
  assert.match(page, /googleCalendar\.preview\.coverageStartDate/);
  assert.match(page, /googleCalendar\.preview\s*\.coverageEndDateExclusive/);
  assert.match(
    prose(page),
    /Las series se cuentan una vez y sus ocurrencias por separado/,
  );
});

test("habilitar revalida el alcance y ejecuta la importación inicial en orden", () => {
  const page = source("src/components/settings/GoogleCalendarSettings.tsx");
  const start = page.indexOf("const reviewedPreview");
  const end = page.indexOf("</button>", start);
  const action = page.slice(start, end);

  assert.ok(start >= 0 && end > start);
  const secondPreview = action.indexOf('body: { mode: "preview" }');
  const comparison = action.indexOf("sameCalendarImportPreview");
  const confirmation = action.indexOf("window.confirm");
  const approval = action.indexOf('mode: "approve_first_import"');
  const initialImport = action.indexOf('mode: "initial_import"');
  const refresh = action.indexOf(
    "await loadGoogleCalendarStatus()",
    initialImport,
  );
  assert.ok(secondPreview >= 0);
  assert.ok(comparison > secondPreview);
  assert.ok(confirmation > comparison);
  assert.ok(approval > confirmation);
  assert.ok(initialImport > approval);
  assert.ok(refresh > initialImport);
  assert.match(action, /Actualizamos el resumen y no importamos nada/);
  assert.match(action, /importData\?\.processed !== true/);
  assert.match(action, /importData\?\.mode !== "initial_import"/);
  assert.match(action, /outcome !== "completed"/);
  assert.match(action, /summary\.failed > 0/);
  assert.match(action, /rawInbound\.error !== null/);
  assert.match(action, /rawInbound\.skippedReason !== null/);
  assert.match(action, /rawInbound\.truncated !== false/);
  assert.match(action, /describeCalendarSync/);
});

test("una aprobación persistida conserva un reintento explícito de initial_import", () => {
  const page = source("src/components/settings/GoogleCalendarSettings.tsx");
  const start = page.indexOf("const reviewedPreview");
  const end = page.indexOf("</button>", start);
  const action = page.slice(start, end);

  assert.match(
    page,
    /googleCalendar\.inboundSyncState !== "incremental" && \(/,
  );
  assert.match(action, /if \(!approvalSaved\)/);
  assert.match(action, /body: \{ mode: "initial_import" \}/);
  assert.match(action, /No se perdió la aprobación/);
  assert.match(action, /2\. Reintentar importación/);
});

test("el panel no confunde una conexión nueva con una sincronización completa", () => {
  const page = source("src/components/settings/GoogleCalendarSettings.tsx");

  assert.match(page, /googleCalendarSyncStatus\(\{/);
  assert.match(page, /googleCalendar\.syncStatus === "first_import"/);
  assert.match(page, /"Importación pendiente"/);
  assert.match(page, /googleCalendar\.syncStatus === "not_checked"/);
  assert.match(page, /"Sin revisión"/);
});

test("Sincronizar ahora queda bloqueado hasta completar la primera importación", () => {
  const page = source("src/components/settings/GoogleCalendarSettings.tsx");
  const syncStart = page.indexOf('googleCalendar.action = "sync"');
  const buttonStart = page.lastIndexOf("<button", syncStart);
  const buttonEnd = page.indexOf("</button>", syncStart);
  const syncButton = page.slice(buttonStart, buttonEnd);

  assert.ok(
    buttonStart >= 0 && syncStart > buttonStart && buttonEnd > syncStart,
  );
  assert.match(syncButton, /canRunManualGoogleCalendarSync/);
  assert.match(syncButton, /googleCalendar\.firstImportApproved/);
  assert.match(syncButton, /googleCalendar\.inboundSyncState/);
  assert.match(syncButton, /googleCalendar\.connected/);
  assert.match(syncButton, /Completá la importación primero/);
});

test("reconnect_required conserva la acción de desconexión para cambiar de cuenta", () => {
  const page = source("src/components/settings/GoogleCalendarSettings.tsx");

  assert.match(
    page,
    /googleCalendar\.connected \|\|\s*googleCalendar\.syncStatus === "reconnect"/,
  );
  assert.match(page, /:\s*"Desconectar"/);
});

test("metadata_changed administrado permite restaurar; importado exige revisión separada", () => {
  const page = source("src/components/settings/GoogleCalendarSettings.tsx");
  const conflictsStart = page.indexOf('class="calendar-conflicts"');
  const conflictsEnd = page.indexOf("{state.isAdmin && (", conflictsStart);
  const conflicts = page.slice(conflictsStart, conflictsEnd);

  assert.ok(conflictsStart >= 0 && conflictsEnd > conflictsStart);
  assert.match(conflicts, /conflict\.kind === "metadata_changed"/);
  assert.match(conflicts, /Se modificaron datos del evento en Google/);
  assert.match(conflicts, /Restaurar desde la agenda/);
  assert.match(conflicts, /\{!conflict\.imported && \(/);
  assert.match(conflicts, /Revisar cambio/);
  assert.match(
    conflicts,
    /\{conflict\.kind !== "metadata_changed" && \(\s*<button/,
  );
});

test("una falla al cargar conflictos queda visible y ofrece reintento", () => {
  const page = source("src/components/settings/GoogleCalendarSettings.tsx");
  const loaderStart = page.indexOf("const loadGoogleCalendarStatus");
  const loaderEnd = page.indexOf(
    "const loadSelectableGoogleCalendars",
    loaderStart,
  );
  const loader = page.slice(loaderStart, loaderEnd);
  const conflictsStart = page.indexOf('class="calendar-conflicts"');
  const conflictsEnd = page.indexOf("{state.isAdmin && (", conflictsStart);
  const conflicts = page.slice(conflictsStart, conflictsEnd);

  assert.ok(loaderStart >= 0 && loaderEnd > loaderStart);
  assert.doesNotMatch(
    loader,
    /loadCalendarConflicts[\s\S]*?\.catch\([\s\S]*?=>\s*\[\]/,
    "una consulta fallida no debe aparentar que no hay conflictos",
  );
  assert.match(loader, /googleCalendar\.conflictsError\s*=\s*""/);
  assert.match(loader, /catch\s*\{[\s\S]*googleCalendar\.conflictsError\s*=/);

  assert.ok(conflictsStart >= 0 && conflictsEnd > conflictsStart);
  assert.match(
    page,
    /googleCalendar\.conflictCount\s*>\s*0\s*\|\|\s*googleCalendar\.conflicts\.length\s*>\s*0/,
  );
  assert.match(conflicts, /googleCalendar\.conflictsError/);
  assert.match(conflicts, /onClick\$=\{loadGoogleCalendarStatus\}/);
  assert.match(conflicts, /Volver a intentar/);
});

test("resolver un conflicto es exclusivo, refresca resultados dudosos y libera el estado", () => {
  const page = source("src/components/settings/GoogleCalendarSettings.tsx");

  for (const contract of [
    {
      rpc: '"reject_google_calendar_conflict"',
      progress: "Guardando…",
    },
    { rpc: '"apply_google_calendar_conflict"', progress: "Aplicando…" },
  ]) {
    const rpc = page.indexOf(contract.rpc);
    const actionStart = page.lastIndexOf("onClick$={async () =>", rpc);
    const actionEnd = page.indexOf("</button>", rpc);
    const action = page.slice(actionStart, actionEnd);

    assert.ok(rpc >= 0 && actionStart >= 0 && actionEnd > rpc);
    assert.match(action, /Boolean\(googleCalendar\.resolving\)/);
    assert.match(action, /Boolean\(googleCalendar\.action\)/);
    assert.match(action, /try\s*\{/);
    assert.match(action, /catch\s*\{/);
    assert.match(
      action,
      /catch\s*\{[\s\S]*await loadGoogleCalendarStatus\(\)/,
      "si la respuesta se pierde, debe refrescar antes de permitir un reintento",
    );
    assert.match(
      action,
      /const refreshed\s*=\s*await loadGoogleCalendarStatus/,
    );
    assert.match(action, /googleCalendar\.conflicts\.filter/);
    assert.match(action, /se guardó, pero no pudimos actualizar la vista/);
    assert.match(action, /No pudimos confirmar si/);
    assert.doesNotMatch(action, /El turno quedó como estaba/);
    assert.match(
      action,
      /finally\s*\{[\s\S]*googleCalendar\.resolving\s*=\s*""/,
    );
    assert.match(action, new RegExp(contract.progress));
  }
});

test("sincronizar y desconectar se bloquean mientras se resuelve un conflicto", () => {
  const page = source("src/components/settings/GoogleCalendarSettings.tsx");
  const actionsStart = page.indexOf(
    '<div class="google-calendar-actions">',
    page.indexOf('class="calendar-conflicts"'),
  );
  const actionsEnd = page.indexOf(") : (", actionsStart);
  const actions = page.slice(actionsStart, actionsEnd);

  assert.ok(actionsStart >= 0 && actionsEnd > actionsStart);
  for (const operation of [
    'googleCalendar.action = "sync"',
    'googleCalendar.action = "disconnect"',
  ]) {
    const operationIndex = actions.indexOf(operation);
    const handlerStart = actions.lastIndexOf(
      "onClick$={async () =>",
      operationIndex,
    );
    const handler = actions.slice(handlerStart, operationIndex);
    assert.ok(operationIndex >= 0 && handlerStart >= 0);
    assert.match(handler, /Boolean\(googleCalendar\.action\)/);
    assert.match(handler, /Boolean\(googleCalendar\.resolving\)/);
  }
});

test("los eventos no soportados explican el cierre preventivo real", () => {
  const page = source("src/components/settings/GoogleCalendarSettings.tsx");
  const noticeStart = page.indexOf("{googleCalendar.unsupportedCount > 0 && (");
  const noticeEnd = page.indexOf(
    '<div class="google-calendar-note">',
    noticeStart,
  );
  const notice = page.slice(noticeStart, noticeEnd);

  assert.ok(noticeStart >= 0 && noticeEnd > noticeStart);
  assert.match(prose(notice), /la agenda no ofrece horarios/i);
  assert.match(prose(notice), /ni envía cambios a Google/i);
  assert.match(prose(notice), /No hace falta modificar el calendario/i);
  assert.doesNotMatch(notice, /convert/i);
  assert.doesNotMatch(notice, /para no ocupar la agenda por error/i);
});

test("la elección muestra sólo nombre, principal y zona horaria", () => {
  const page = source("src/components/settings/GoogleCalendarSettings.tsx");
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
