import assert from "node:assert/strict";
import test from "node:test";
import {
  detectInboxNotifications,
  type InboxSnapshot,
} from "./inbox-notifications.ts";

function snapshot(overrides: Partial<InboxSnapshot> = {}): InboxSnapshot {
  return { unreadCount: 0, confirmedDeposits: 0, ...overrides };
}

test("la primera lectura nunca avisa", () => {
  assert.deepEqual(
    detectInboxNotifications(null, snapshot({ unreadCount: 12 })),
    [],
    "abrir el panel con mensajes viejos sin leer no es una novedad",
  );
});

test("avisa por los mensajes que llegaron desde la última lectura", () => {
  const [notification] = detectInboxNotifications(
    snapshot({ unreadCount: 2 }),
    snapshot({ unreadCount: 5 }),
  );
  assert.equal(notification.kind, "message");
  assert.equal(notification.count, 3);
  assert.match(notification.title, /3 mensajes nuevos/);
});

test("un solo mensaje se anuncia en singular", () => {
  const [notification] = detectInboxNotifications(
    snapshot({ unreadCount: 0 }),
    snapshot({ unreadCount: 1 }),
  );
  assert.match(notification.title, /un mensaje nuevo/i);
});

test("leer mensajes no genera aviso", () => {
  assert.deepEqual(
    detectInboxNotifications(
      snapshot({ unreadCount: 5 }),
      snapshot({ unreadCount: 1 }),
    ),
    [],
  );
});

test("avisa cuando se confirma una seña", () => {
  const [notification] = detectInboxNotifications(
    snapshot({ confirmedDeposits: 4 }),
    snapshot({ confirmedDeposits: 5 }),
  );
  assert.equal(notification.kind, "deposit");
  assert.match(notification.title, /Se confirmó una seña/);
});

test("puede avisar por las dos cosas a la vez", () => {
  const notifications = detectInboxNotifications(
    snapshot({ unreadCount: 0, confirmedDeposits: 0 }),
    snapshot({ unreadCount: 2, confirmedDeposits: 1 }),
  );
  assert.deepEqual(
    notifications.map((item) => item.kind),
    ["message", "deposit"],
  );
});

test("sin cambios no hay aviso", () => {
  const same = snapshot({ unreadCount: 3, confirmedDeposits: 2 });
  assert.deepEqual(detectInboxNotifications(same, { ...same }), []);
});
