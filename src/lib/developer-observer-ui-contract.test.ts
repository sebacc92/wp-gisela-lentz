import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

test("la capacidad observadora es independiente del rol ADMIN", () => {
  const context = source("src/components/app/AppUserContext.ts");
  const layout = source("src/routes/app/layout.tsx");

  assert.match(context, /isAdmin:\s*boolean/);
  assert.match(context, /preserveInboxUnread:\s*boolean/);
  assert.match(
    layout,
    /select\("full_name,role,active,preserve_inbox_unread"\)/,
  );
  assert.match(layout, /appUser\.isAdmin\s*=\s*isAdminProfile\(profile\)/);
  assert.match(
    layout,
    /appUser\.preserveInboxUnread\s*=\s*profile\.preserve_inbox_unread\s*===\s*true/,
  );
});

test("abrir un chat en modo observador no altera el contador ni llama al RPC", () => {
  const inbox = source("src/routes/app/inbox/index.tsx");
  const handlerStart = inbox.indexOf("onSelect$={async (id) => {");
  const handlerEnd = inbox.indexOf("      />", handlerStart);

  assert.ok(handlerStart >= 0);
  assert.ok(handlerEnd > handlerStart);

  const handler = inbox.slice(handlerStart, handlerEnd);
  const observerGate = handler.indexOf(
    "if (appUser.preserveInboxUnread) return;",
  );
  const optimisticRead = handler.indexOf("conversation.unreadCount = 0");
  const authoritativeRead = handler.indexOf('"mark_conversation_read"');

  assert.ok(observerGate >= 0);
  assert.ok(observerGate < optimisticRead);
  assert.ok(observerGate < authoritativeRead);
  assert.match(handler, /selectedId\.value\s*=\s*id/);
  assert.match(handler, /mobileChatOpen\.value\s*=\s*true/);
});

test("la navegación identifica el modo sin confundirlo con una sesión común", () => {
  const navigation = source("src/components/app/AppNavigation.tsx");

  assert.match(navigation, /Desarrollador · modo observador/);
  assert.match(navigation, /Abrir chats no los marca como leídos/);
  assert.match(
    navigation,
    /filter\(\(item\) => !item\.adminOnly \|\| appUser\.isAdmin\)/,
  );
});
