import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

test("la bandeja presenta la ubicación como una tarjeta simple y accesible", () => {
  const bubble = source("src/components/inbox/MessageBubble.tsx");

  assert.match(bubble, /message\.type === "location" && message\.location/);
  assert.match(bubble, /<Icon name="map-pin"/);
  assert.match(bubble, /Abrir en Google Maps/);
  assert.match(bubble, /target="_blank"/);
  assert.match(bubble, /rel="noopener noreferrer"/);
});

test("si el snapshot del pin no es válido la burbuja conserva el texto", () => {
  const bubble = source("src/components/inbox/MessageBubble.tsx");

  assert.match(
    bubble,
    /message\.type === "location" && message\.location[\s\S]*?: \([\s\S]*?<p>\{message\.body\}<\/p>/,
  );
});
