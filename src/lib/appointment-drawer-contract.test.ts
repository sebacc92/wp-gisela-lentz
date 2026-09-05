import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

const drawer = () => source("src/routes/app/appointments/index.tsx");
const data = () => source("src/lib/supabase/data.ts");
const styles = () => source("src/global.css");

test("el detalle del turno es un diálogo modal navegable con teclado", () => {
  const page = drawer();

  assert.match(page, /role="dialog"/);
  assert.match(page, /aria-modal="true"/);
  assert.match(page, /aria-labelledby="appointment-detail-title"/);
  assert.match(page, /aria-label="Cerrar el detalle del turno"/);
  // Escape cierra, salvo mientras una acción está en curso.
  assert.match(page, /event\.key === "Escape" && !detailBusy/);
  // Foco inicial al abrir y devolución al cerrar.
  assert.match(page, /detailRef\.value\?\.focus\(\)/);
  assert.match(page, /previousFocus\.focus\(\)/);
  assert.match(page, /document\.contains\(previousFocus\)/);
});

test("una acción deshabilitada se explica con texto visible, no sólo con title", () => {
  const page = drawer();

  assert.match(page, /id="detail-attendance-hint"/);
  assert.match(page, /aria-describedby=\{/);
  assert.match(page, /se habilitan después de la\s*\n?\s*hora del turno/);
  // `title` es invisible en una pantalla táctil.
  assert.doesNotMatch(page, /title=\{\s*selectedAppointmentHasStarted/);
  assert.match(styles(), /\.detail-disabled-hint \{/);
});

test("el ancho y el padding del detalle sobreviven a las reglas históricas", () => {
  const css = styles();

  assert.match(
    css,
    /\.drawer\.appointment-detail-drawer \{[^}]*width: clamp\(420px, 34vw, 540px\)/,
  );
  assert.match(
    css,
    /\.appointment-detail-content \{[^}]*padding: 20px 24px 24px/,
  );
  // Sin igualar la especificidad de `.appointment-detail-content dl div`, cada
  // campo vuelve a llevar borde y 14px de padding.
  assert.match(css, /\.appointment-detail-content \.detail-grid > div \{/);
  assert.match(css, /@media \(max-width: 680px\)/);
});

test("el operador siempre puede llegar al comprobante, incluso sin asociar", () => {
  const page = drawer();

  assert.match(page, /Revisar comprobante/);
  // Si la automatización no pudo asociarlo, se ofrece abrir la conversación.
  assert.match(page, /Ver conversación/);
  assert.match(page, /No hay un comprobante asociado a este turno/);
});

test("la confirmación aclara que es una decisión, no una verificación bancaria", () => {
  const page = drawer();

  assert.match(page, /¿Confirmar la seña y el turno\?/);
  assert.match(page, /el sistema no verifica la transferencia con el banco/);
  // Un rechazo del RPC explica qué acción corresponde.
  assert.match(page, /describeDepositConfirmationError/);
});

test("la conversión de un bloqueo está conectada a su RPC transaccional", () => {
  const page = drawer();
  const converter = source(
    "src/components/appointments/ConvertBlockDrawer.tsx",
  );
  const lib = source("src/lib/calendar-block-conversion.ts");

  // La acción existe en la agenda y abre el formulario dedicado.
  assert.match(page, /ConvertBlockDrawer/);
  assert.match(page, /Convertir en turno/);
  assert.match(page, /convertingBlockId/);

  // El formulario explica la sustitución antes de convertir.
  assert.match(converter, /se reemplaza por el turno/);

  // Una sola vía de creación: el RPC transaccional, nunca una segunda
  // implementación de reserva desde el navegador.
  assert.match(lib, /convert_google_calendar_block_to_appointment/);
  assert.doesNotMatch(
    converter,
    /create_service_appointment|create_appointment/,
  );
  assert.doesNotMatch(lib, /create_service_appointment|create_appointment/);
  // El RPC viejo, que exigía un turno ya creado, no puede volver.
  assert.doesNotMatch(converter, /"convert_google_calendar_block"/);
});

test("un fallo al cargar bloqueos no se presenta como agenda libre", () => {
  const page = drawer();

  assert.match(page, /loadCalendarBlocks\(client, fromIso, toIso\)/);
  assert.doesNotMatch(
    page,
    /loadCalendarBlocks\(client, fromIso, toIso\)\.catch/,
  );
  assert.match(page, /No pudimos cargar la agenda\./);
});

test("los bloqueos respetan rangos semiabiertos y muestran los de todo el día", () => {
  const page = drawer();
  const queries = data();

  // Un evento que termina exactamente al comenzar el día no se superpone.
  assert.match(queries, /\.gt\("ends_at", fromIso\)/);
  assert.doesNotMatch(queries, /\.gte\("ends_at", fromIso\)/);
  assert.match(
    queries,
    /\.select\("google_event_id,summary,starts_at,ends_at,all_day"\)/,
  );
  assert.match(queries, /allDay: row\.all_day/);

  // La fecha final de Google es exclusiva: el indicador evita mostrar
  // engañosamente un bloqueo de todo el día como 00:00 – 00:00.
  assert.match(page, /block\.allDay\s*\?\s*\(\s*"Todo el día"/);
});
