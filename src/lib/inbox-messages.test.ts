import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  inboxMessagePageFromRows,
  INBOX_MESSAGE_PAGE_SIZE,
  loadOlderInboxMessages,
  type InboxMessageRow,
} from "./supabase/inbox-messages.ts";

function messageRow(index: number): InboxMessageRow {
  return {
    id: `message-${String(index).padStart(3, "0")}`,
    conversation_id: "conversation-1",
    body: `Mensaje ${index}`,
    direction: index % 2 === 0 ? "inbound" : "outbound",
    type: "text",
    status: "delivered",
    created_at: new Date(Date.UTC(2026, 0, 2, 12, 0, -index)).toISOString(),
    whatsapp_ingest_sequence: 1000 - index,
    metadata: {},
  };
}

test("limita cada página y entrega los mensajes en orden cronológico", () => {
  const rows = Array.from({ length: INBOX_MESSAGE_PAGE_SIZE + 1 }, (_, index) =>
    messageRow(index),
  );

  const page = inboxMessagePageFromRows(rows);

  assert.equal(page.messages.length, INBOX_MESSAGE_PAGE_SIZE);
  assert.equal(page.hasOlderMessages, true);
  assert.equal(page.messages[0]?.id, "message-049");
  assert.equal(page.messages.at(-1)?.id, "message-000");
});

test("mapea una ubicación validada a un enlace seguro de Google Maps", () => {
  const row = {
    ...messageRow(0),
    type: "location" as const,
    body: "Ubicación del consultorio",
    metadata: {
      business_maps_url:
        "https://www.google.com/maps/search/?api=1&query=Centro%20de%20Atenci%C3%B3n%20Profesional%20%28C.A.P.%29&query_place_id=ChIJK5iJNYYQhZURBREHhxeQ9PQ",
      location: {
        latitude: -38.2657317,
        longitude: -57.8353134,
        name: "  Consultorio de la Odontóloga Gisela Lentz  ",
        address: "Calle 11 1375, Miramar, Buenos Aires",
        mapUrl: "javascript:alert(1)",
      },
    },
  } satisfies InboxMessageRow;

  const message = inboxMessagePageFromRows([row]).messages[0];

  assert.deepEqual(message?.location, {
    latitude: -38.2657317,
    longitude: -57.8353134,
    name: "Consultorio de la Odontóloga Gisela Lentz",
    address: "Calle 11 1375, Miramar, Buenos Aires",
    mapUrl:
      "https://www.google.com/maps/search/?api=1&query=Centro%20de%20Atenci%C3%B3n%20Profesional%20%28C.A.P.%29&query_place_id=ChIJK5iJNYYQhZURBREHhxeQ9PQ",
  });
});

test("una ubicación incompleta conserva el texto y no expone un enlace", () => {
  const row = {
    ...messageRow(0),
    type: "location" as const,
    body: "Ubicación del consultorio",
    metadata: {
      location: {
        latitude: 91,
        longitude: -57.8353134,
        name: "Consultorio",
        address: "Calle 11 1375",
      },
    },
  } satisfies InboxMessageRow;

  const message = inboxMessagePageFromRows([row]).messages[0];

  assert.equal(message?.body, "Ubicación del consultorio");
  assert.equal(message?.location, undefined);
});

test("carga páginas anteriores con cursor estable de fecha y secuencia", async () => {
  const calls: Array<[string, ...unknown[]]> = [];
  const rows = [messageRow(50), messageRow(51)];
  const query = {
    select(columns: string) {
      calls.push(["select", columns]);
      return this;
    },
    eq(column: string, value: string) {
      calls.push(["eq", column, value]);
      return this;
    },
    is(column: string, value: null) {
      calls.push(["is", column, value]);
      return this;
    },
    or(filter: string) {
      calls.push(["or", filter]);
      return this;
    },
    order(column: string, options: unknown) {
      calls.push(["order", column, options]);
      return this;
    },
    async limit(limit: number) {
      calls.push(["limit", limit]);
      return { data: rows, error: null };
    },
  };
  const client = {
    from(table: string) {
      calls.push(["from", table]);
      return query;
    },
  } as unknown as SupabaseClient;

  const page = await loadOlderInboxMessages(client, "conversation-1", {
    createdAt: "2026-01-02T11:59:11.000Z",
    ingestSequence: 951,
  });

  assert.deepEqual(
    page.messages.map((message) => message.id),
    ["message-051", "message-050"],
  );
  assert.equal(page.hasOlderMessages, false);
  assert.deepEqual(calls[0], ["from", "messages"]);
  assert.deepEqual(
    calls.find(([method]) => method === "eq"),
    ["eq", "conversation_id", "conversation-1"],
  );
  assert.deepEqual(
    calls.find(([method]) => method === "is"),
    ["is", "original_whatsapp_message_id", null],
  );
  assert.match(
    String(calls.find(([method]) => method === "or")?.[1]),
    /created_at\.lt\..+whatsapp_ingest_sequence\.lt\.951/,
  );
  assert.deepEqual(calls.filter(([method]) => method === "order").at(-1), [
    "order",
    "whatsapp_ingest_sequence",
    { ascending: false },
  ]);
  assert.deepEqual(calls.at(-1), ["limit", INBOX_MESSAGE_PAGE_SIZE + 1]);
});
