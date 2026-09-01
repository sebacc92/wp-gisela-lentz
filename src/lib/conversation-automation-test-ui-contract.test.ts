import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

test("el control de prueba vive dentro de cada conversación", () => {
  const chat = source("src/components/inbox/ChatPanel.tsx");
  const navigation = source("src/components/app/AppNavigation.tsx");

  assert.match(chat, /<ConversationBotTestControl/);
  assert.doesNotMatch(navigation, /ConversationBotTestControl/);
});

test("la UI usa sólo RPCs autenticados y wording explícito por chat", () => {
  const control = source("src/components/inbox/ConversationBotTestControl.tsx");

  assert.match(control, /get_whatsapp_conversation_automation_state/);
  assert.match(control, /activate_whatsapp_conversation_test_override/);
  assert.match(control, /deactivate_whatsapp_conversation_test_override/);
  assert.match(control, /Activar bot 24 h para este chat/);
  assert.match(control, /no enciende el bot para los demás chats/);
  assert.doesNotMatch(control, /service[_-]?role/i);
});

test("sólo ADMIN recibe controles de activación, extensión y revocación", () => {
  const control = source("src/components/inbox/ConversationBotTestControl.tsx");

  assert.match(
    control,
    /const canActivate =[\s\S]*?appUser\.isAdmin[\s\S]*?!globalEnabled/,
  );
  assert.match(
    control,
    /const canDeactivate =[\s\S]*?appUser\.isAdmin[\s\S]*?display\.overrideActive/,
  );
  assert.match(control, /Extender 24 h desde ahora/);
  assert.match(control, /Desactivar prueba/);
});

test("el panel muestra simultáneamente estado global, efectivo y vencimiento", () => {
  const control = source("src/components/inbox/ConversationBotTestControl.tsx");

  assert.match(control, />Bot global</);
  assert.match(control, />Este chat</);
  assert.match(control, />Activo hasta</);
  assert.match(control, /la pausa o el estado[\s\S]*sigue bloqueando/);
});

test("descarta respuestas RPC tardías de una conversación ya deseleccionada", () => {
  const control = source("src/components/inbox/ConversationBotTestControl.tsx");

  assert.match(
    control,
    /selectedConversationId\.value !== targetConversationId/,
  );
  assert.match(control, /stateRequestVersion\.value !== requestVersion/);
  assert.match(control, /const targetConversationId = props\.conversationId/);
  assert.match(
    control,
    /state\.value\?\.conversationId === props\.conversationId/,
  );
});

test("un resultado de mutación ambiguo exige releer antes de otra acción", () => {
  const control = source("src/components/inbox/ConversationBotTestControl.tsx");

  assert.match(control, /Volvé a consultar el estado antes de continuar/);
  assert.match(control, /state\.value = null;[\s\S]*state\.error = SAVE_ERROR/);
  assert.doesNotMatch(control, /El estado anterior sigue vigente/);
});
