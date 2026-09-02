import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

test("el mensaje escrito Consulta conserva la ruta de selección de servicio", () => {
  const automation = source("supabase/functions/whatsapp-automation/index.ts");
  const selectionStart = automation.indexOf(
    'session.state === "selecting_service"',
  );
  const selectionEnd = automation.indexOf(
    'session.state === "selecting_slot"',
    selectionStart,
  );

  assert.ok(selectionStart >= 0 && selectionEnd > selectionStart);
  assert.match(
    automation,
    /normalizedInboundBody\s*=\s*normalizeUserInput\(inboundBody\)/,
  );

  const selection = automation.slice(selectionStart, selectionEnd);
  assert.match(selection, /if \(!serviceId && !replyId\)/);
  assert.match(selection, /\.from\("services"\)/);
  assert.match(selection, /\.eq\("active", true\)/);
  assert.match(
    selection,
    /normalizeUserInput\(service\.name as string\)\s*===\s*normalizedInboundBody/,
  );
});

test("Consulta permanece activa en la migración de servicios", () => {
  const migration = source(
    "supabase/migrations/20260829234000_add_consulta_service.sql",
  );

  assert.match(migration, /'Consulta',[\s\S]{0,80}\btrue\b/);
  assert.match(migration, /update public\.services\s+set active = true/);
  assert.match(
    migration,
    /where lower\(trim\(services\.name\)\) = ordered\.normalized_name/,
  );
});

test("la verificación de automatización ejecuta Deno sobre todas las Edge Functions", () => {
  const packageJson = JSON.parse(source("package.json")) as {
    scripts?: Record<string, string>;
  };
  const scripts = packageJson.scripts ?? {};

  assert.equal(
    scripts["build.types:functions"],
    "deno check supabase/functions",
  );
  // `build.types` queda deliberadamente fuera de la cadena de Deno: Qwik lo
  // invoca durante el build con `--pretty`, y en el entorno de Vercel Deno no
  // resuelve los npm: de las Edge Functions. Encadenarlo ahí rompe el deploy
  // productivo. La verificación vive en `test:automation`, que sí lo corre.
  assert.doesNotMatch(scripts["build.types"] ?? "", /build\.types:functions/);
  assert.match(scripts["test:automation"] ?? "", /build\.types:functions/);
  assert.equal(scripts["lint:functions"], "deno lint supabase/functions");
  assert.match(scripts.lint ?? "", /lint:functions/);
});

test("el aviso fuera de horario no convierte los mensajes siguientes en silencio", () => {
  const automation = source("supabase/functions/whatsapp-automation/index.ts");

  assert.doesNotMatch(automation, /OUT_OF_HOURS_COOLDOWN/);
  assert.match(automation, /saveSession\(\s*"out_of_hours"/);
  assert.match(automation, /showMainMenu/);
});

test("un fallo o apagado de IA administrativa nunca completa en silencio", () => {
  const automation = source("supabase/functions/whatsapp-automation/index.ts");
  const infoStart = automation.indexOf("const showClinicInfo = async (");
  const infoEnd = automation.indexOf(
    "const showAppointmentConfirmation",
    infoStart,
  );
  assert.ok(infoStart >= 0 && infoEnd > infoStart);
  const infoFlow = automation.slice(infoStart, infoEnd);

  assert.match(
    infoFlow,
    /OPENAI_DURABILITY_UNAVAILABLE[\s\S]{0,500}await showConfiguredInfo\(\)/,
  );
  assert.match(
    infoFlow,
    /!beforeCall\.automationsEnabled[\s\S]{0,250}await handoff/,
  );
  assert.match(
    infoFlow,
    /!beforeSend\.automationsEnabled[\s\S]{0,250}await handoff/,
  );
  assert.match(
    infoFlow,
    /answer\.source === "openai" && !beforeSend\.aiEnabled[\s\S]{0,150}await showConfiguredInfo/,
  );
});

test("las operaciones automáticas hablan como el consultorio", () => {
  const automation = source("supabase/functions/whatsapp-automation/index.ts");

  assert.match(automation, /¡Listo! Tu turno quedó confirmado/);
  assert.match(automation, /¡Listo! Tu turno quedó reprogramado/);
  assert.match(automation, /Tu turno quedó cancelado/);
  assert.match(automation, /Tu turno ya está confirmado/);
  assert.doesNotMatch(
    automation,
    /(?:Reservé|Reprogramé|Cancelé|Ya confirmé) tu turno/,
  );
  assert.match(
    automation,
    /Voy a derivar tu consulta para que puedan ayudarte/,
  );
  assert.doesNotMatch(
    automation,
    /Sigo yo desde acá|te respondo apenas lo vea|la reviso yo personalmente|continuar personalmente|Mandame el comprobante|Anoté que vas a asistir|pendiente de mi revisión/,
  );
});
