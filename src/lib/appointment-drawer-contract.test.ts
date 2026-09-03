import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

const drawer = () => source("src/routes/app/appointments/index.tsx");
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
