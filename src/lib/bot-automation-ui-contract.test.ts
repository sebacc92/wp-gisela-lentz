import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

test("Inicio mobile ofrece el switch sin esconderlo dentro de Más", () => {
  const home = source("src/routes/app/index.tsx");
  const navigation = source("src/components/app/AppNavigation.tsx");
  const styles = source("src/global.css");

  assert.match(home, /<BotAutomationControl variant="home" \/>/);
  assert.match(navigation, /<BotAutomationControl variant="sidebar" \/>/);
  assert.equal(
    navigation.match(/<BotAutomationControl/g)?.length,
    1,
    "mobile Más must not render a second hidden bot control",
  );
  assert.doesNotMatch(navigation, /mobile-bot-switch/);
  assert.match(styles, /\.dashboard-bot-control\s*\{\s*display: none;/);
  assert.match(
    styles,
    /@media \(max-width: 680px\)[\s\S]*?\.dashboard-bot-control\s*\{[\s\S]*?display: block;/,
  );
});

test("sidebar e Inicio comparten el estado confirmado del bot", () => {
  const context = source("src/components/app/BotAutomationContext.ts");
  const control = source("src/components/app/BotAutomationControl.tsx");
  const layout = source("src/routes/app/layout.tsx");

  assert.match(context, /enabled: boolean \| null/);
  assert.match(context, /saving: boolean/);
  assert.match(context, /error: string/);
  assert.match(layout, /useContextProvider\(BOT_AUTOMATION_CONTEXT/);
  assert.match(layout, /select\("automations_enabled"\)/);
  assert.match(control, /useContext\(BOT_AUTOMATION_CONTEXT\)/);
});

test("Configuración y Manual muestran el mismo estado operativo", () => {
  const settings = source("src/components/settings/WhatsAppSettings.tsx");
  const manual = source("src/routes/app/manual/index.tsx");

  assert.match(settings, /useContext\(BOT_AUTOMATION_CONTEXT\)/);
  assert.match(settings, /botAutomation\.enabled === null/);
  assert.match(settings, /botAutomation\.enabled === false/);
  assert.doesNotMatch(settings, /state\.automationsEnabled/);
  assert.match(manual, /useContext\(BOT_AUTOMATION_CONTEXT\)/);
  assert.match(
    manual,
    /automation: automationManualStatus\(botAutomation\.enabled\)/,
  );
});

test("el guardado confirma la fila y hace visible cualquier fallo", () => {
  const control = source("src/components/app/BotAutomationControl.tsx");
  const updateStart = control.indexOf(".update({ automations_enabled: next })");
  const updateEnd = control.indexOf(".single();", updateStart);
  assert.ok(updateStart >= 0 && updateEnd > updateStart);

  const update = control.slice(updateStart, updateEnd);
  assert.match(update, /\.eq\("id", true\)/);
  assert.match(update, /\.select\("automations_enabled"\)/);
  assert.match(control, /data\?\.automations_enabled !== next/);
  assert.match(control, /bot\.enabled = previous/);
  assert.match(control, /role=\{bot\.error \? "alert" : "status"\}/);
  assert.match(control, />\s*Reintentar\s*</);
});

test("la posición segura persistida del bot es apagado", () => {
  const migration = source(
    "supabase/migrations/20260830231000_automations_default_off.sql",
  );
  const databaseTest = source("supabase/tests/automations_toggle.sql");

  assert.match(migration, /alter column automations_enabled set default false/);
  assert.match(migration, /set automations_enabled = false/);
  assert.match(databaseTest, /automations must default to disabled/);
  assert.match(databaseTest, /an ADMIN can switch the bot on/);
});
