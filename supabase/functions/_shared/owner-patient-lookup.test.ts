import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.112.2";

import { resolveOwnerPatientLookup } from "./owner-patient-lookup.ts";

const NOW = new Date("2026-09-07T20:00:00.000Z");
const OWNER = "+5492291575215";
const CONVERSATION = "341c25de-c95a-45fb-8552-672cdbe727f4";
const MATIAS_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_ID = "00000000-0000-4000-8000-000000000002";
type Row = Record<string, unknown>;
type Read = {
  table: string;
  columns: string;
  equalities: Array<[string, unknown]>;
  range?: [number, number];
};

function contact(
  id = MATIAS_ID,
  name = "Matias Icardo",
  phone = "+5491112345678",
): Row {
  return {
    id,
    name,
    phone_e164: phone,
    coverage: "ioma",
    notes: "Nota clínica privada",
  };
}

function appointment(overrides: Row = {}): Row {
  return {
    id: "turno-matias",
    contact_id: MATIAS_ID,
    starts_at: "2026-09-16T23:00:00.000Z",
    status: "confirmed",
    deposit_status: "not_required",
    hold_expires_at: null,
    coverage: "ioma",
    ...overrides,
  };
}

function compare(row: Row, column: string, expected: unknown): number {
  const actual = row[column];
  if (column.endsWith("_at")) {
    return Date.parse(String(actual)) - Date.parse(String(expected));
  }
  if (actual === expected) return 0;
  return String(actual) < String(expected) ? -1 : 1;
}

function orCondition(expression: string): (row: Row) => boolean {
  const conditions = expression.split(/,(?![^()]*\))/).map((part) => {
    const match = part.match(/^([a-z_]+)\.(eq|gt|not\.in)\.(.+)$/);
    assert.ok(match, `Condición OR no soportada: ${part}`);
    const [, column, operator, value] = match;
    if (operator === "eq") return (row: Row) => row[column] === value;
    if (operator === "gt") {
      return (row: Row) =>
        row[column] != null && compare(row, column, value) > 0;
    }
    assert.match(value, /^\([^()]+\)$/);
    const excluded = value.slice(1, -1).split(",");
    return (row: Row) =>
      row[column] != null && !excluded.includes(String(row[column]));
  });
  return (row) => conditions.some((condition) => condition(row));
}

/** Emula filtros y proyecciones para detectar consultas privadas anticipadas,
 * páginas truncadas y reservas vencidas, sin acceder a datos reales. */
function fakePatientDirectory(input: {
  contacts?: Row[];
  appointments?: Row[];
  fail?: "directory" | "contact" | "appointments";
} = {}) {
  const tables: Record<string, Row[]> = {
    contacts: input.contacts ?? [contact()],
    appointments: input.appointments ?? [appointment()],
  };
  const reads: Read[] = [];
  const client = {
    from(table: string) {
      assert.ok(table in tables, `Tabla inesperada: ${table}`);
      const filters: Array<(row: Row) => boolean> = [];
      const read: Read = { table, columns: "", equalities: [] };
      let orderedBy: string | undefined;
      let ascending = true;
      let maximum = Infinity;
      const result = () => {
        reads.push({ ...read, equalities: [...read.equalities] });
        const kind = table === "appointments"
          ? "appointments"
          : read.columns.includes("phone_e164")
          ? "contact"
          : "directory";
        if (input.fail === kind) {
          return { data: null, error: new Error(`Simulated ${kind} failure`) };
        }
        let rows = tables[table].filter((row) =>
          filters.every((filter) => filter(row))
        );
        if (orderedBy) {
          const column = orderedBy;
          rows.sort((a, b) =>
            compare(a, column, b[column]) * (ascending ? 1 : -1)
          );
        }
        const [start, end] = read.range ?? [0, 999];
        rows = rows.slice(start, Math.min(end + 1, start + maximum));
        const columns = read.columns.split(",").map((column) => column.trim());
        assert.ok(
          !columns.includes("*"),
          "No se debe consultar la ficha completa",
        );
        return {
          data: rows.map((row) =>
            Object.fromEntries(columns.map((column) => [column, row[column]]))
          ),
          error: null,
        };
      };
      const query = {
        select(columns: string) {
          read.columns = columns;
          return query;
        },
        eq(column: string, value: unknown) {
          filters.push((row) => row[column] === value);
          read.equalities.push([column, value]);
          return query;
        },
        in(column: string, values: unknown[]) {
          filters.push((row) => values.includes(row[column]));
          return query;
        },
        gte(column: string, value: unknown) {
          filters.push((row) => compare(row, column, value) >= 0);
          return query;
        },
        or(expression: string) {
          filters.push(orCondition(expression));
          return query;
        },
        order(column: string, options?: { ascending?: boolean }) {
          orderedBy = column;
          ascending = options?.ascending !== false;
          return query;
        },
        range(start: number, end: number) {
          read.range = [start, end];
          return query;
        },
        limit(count: number) {
          maximum = count;
          return query;
        },
        async maybeSingle() {
          const response = result();
          assert.ok(
            !response.data || response.data.length <= 1,
            "maybeSingle no debe elegir entre varias filas",
          );
          return { ...response, data: response.data?.[0] ?? null };
        },
        then(resolve: (value: unknown) => unknown) {
          return Promise.resolve(result()).then(resolve);
        },
      };
      return query;
    },
  } as unknown as SupabaseClient;
  return { client, reads, tables };
}

function lookup(client: SupabaseClient, options: {
  body?: string;
  query?: string;
  pending?: unknown;
  ownerPhone?: string;
  conversationId?: string;
  now?: Date;
} = {}) {
  return resolveOwnerPatientLookup({
    client,
    body: options.body ?? `Datos de ${options.query ?? "Matías Icardo"}`,
    ownerPhone: OWNER,
    conversationId: CONVERSATION,
    now: NOW,
    ...options,
  });
}

function assertNamesOnly(reads: Read[]) {
  for (const read of reads) {
    assert.equal(
      read.table,
      "contacts",
      "No se consultan turnos antes de elegir la persona",
    );
    assert.equal(
      read.columns.replace(/\s/g, ""),
      "id,name",
      "Antes de confirmar sólo se consultan nombres e IDs",
    );
  }
}

test("el caso Matías Icardo encuentra Matias Icardo sin exigir el acento de la ficha", async () => {
  const { client, reads } = fakePatientDirectory();
  const result = await lookup(client, {
    query: "Matías Icardo",
    body: "Cuando se atiende Matías Icardo?",
  });
  assert.ok(result);
  assert.equal(result.pending, null);
  assert.match(result.reply, /Matias Icardo/);
  assert.match(result.reply, /Teléfono: \+5491112345678/);
  assert.match(result.reply, /Próximo turno:.*16[/-]9.*20:00/);
  assert.doesNotMatch(result.reply, /Nota clínica privada|Quisiste decir/);
  assert.equal(reads[0]?.columns, "id,name");
  const detail = reads.find((read) => read.columns.includes("phone_e164"));
  assert.ok(detail);
  assert.deepEqual(detail.equalities, [["id", MATIAS_ID]]);
});

test("un nombre parecido pregunta primero y sólo sí habilita los datos del ID confirmado", async () => {
  const { client, reads } = fakePatientDirectory();
  const suggestion = await lookup(client, { query: "Matias Icaro" });
  assert.ok(suggestion?.pending);
  assert.match(suggestion.reply, /¿Quisiste decir/);
  assert.match(suggestion.reply, /Matias Icardo/);
  assert.doesNotMatch(
    suggestion.reply,
    /Teléfono|Cobertura|Próximo turno|\+549/,
  );
  assertNamesOnly(reads);
  assert.equal(suggestion.pending.ownerPhone, OWNER);
  assert.equal(suggestion.pending.conversationId, CONVERSATION);
  assert.equal(
    Date.parse(suggestion.pending.expiresAt) -
      Date.parse(suggestion.pending.createdAt),
    10 * 60 * 1000,
  );
  assert.deepEqual(suggestion.pending.candidates, [{
    id: MATIAS_ID,
    name: "Matias Icardo",
  }]);

  reads.length = 0;
  const confirmation = await lookup(client, {
    body: "Sí",
    pending: suggestion.pending,
  });
  assert.ok(confirmation);
  assert.equal(confirmation.pending, null);
  assert.match(confirmation.reply, /Teléfono: \+5491112345678/);
  assert.ok(
    reads.some((read) =>
      read.equalities.some(([column, id]) =>
        column === "id" && id === MATIAS_ID
      )
    ),
  );
});

test("no rechaza la sugerencia y descarta la elección pendiente sin consultar datos", async () => {
  const { client, reads } = fakePatientDirectory();
  const suggestion = await lookup(client, { query: "Matias Icaro" });
  assert.ok(suggestion?.pending);
  reads.length = 0;
  const rejected = await lookup(client, {
    body: "No",
    pending: suggestion.pending,
  });
  assert.ok(rejected);
  assert.equal(rejected.pending, null);
  assert.deepEqual(reads, []);
  assert.doesNotMatch(rejected.reply, /Teléfono|Cobertura|Próximo turno|\+549/);
});

test("varios nombres requieren un número: sí no selecciona el primero", async () => {
  const { client, reads } = fakePatientDirectory({
    contacts: [
      contact(),
      contact(OTHER_ID, "Matias Ricardo", "+5491187654321"),
    ],
  });
  const suggestion = await lookup(client, { query: "Matías" });
  assert.ok(suggestion?.pending);
  assert.equal(suggestion.pending.candidates.length, 2);
  assert.match(suggestion.reply, /1[).]/);
  assert.match(suggestion.reply, /2[).]/);
  assertNamesOnly(reads);

  reads.length = 0;
  const ambiguousYes = await lookup(client, {
    body: "Sí",
    pending: suggestion.pending,
  });
  assert.ok(ambiguousYes?.pending);
  assertNamesOnly(reads);
  assert.doesNotMatch(
    ambiguousYes.reply,
    /Teléfono|Cobertura|Próximo turno|\+549/,
  );

  reads.length = 0;
  const selected = await lookup(client, {
    body: "2",
    pending: suggestion.pending,
  });
  assert.ok(selected);
  assert.equal(selected.pending, null);
  const expected = suggestion.pending.candidates[1];
  assert.ok(expected);
  assert.ok(selected.reply.includes(expected.name));
  const detail = reads.find((read) => read.columns.includes("phone_e164"));
  assert.ok(detail);
  assert.deepEqual(detail.equalities, [["id", expected.id]]);
});

test("una nueva búsqueda reemplaza las opciones anteriores", async () => {
  const { client, reads } = fakePatientDirectory({
    contacts: [contact(), contact(OTHER_ID, "Ana Pérez", "+5491187654321")],
  });
  const suggestion = await lookup(client, { query: "Matias Icaro" });
  assert.ok(suggestion?.pending);
  reads.length = 0;
  const result = await lookup(client, {
    body: "Datos de Ana Perez",
    query: "Ana Perez",
    pending: suggestion.pending,
  });
  assert.ok(result);
  assert.equal(result.pending, null);
  assert.match(result.reply, /Ana Pérez/);
  assert.match(result.reply, /\+5491187654321/);
  assert.doesNotMatch(result.reply, /Matias Icardo|\+5491112345678/);
  const detail = reads.find((read) => read.columns.includes("phone_e164"));
  assert.ok(detail);
  assert.deepEqual(detail.equalities, [["id", OTHER_ID]]);
});

test("una opción pendiente no cruza teléfonos, conversaciones ni su vencimiento", async () => {
  const { client, reads } = fakePatientDirectory();
  const suggestion = await lookup(client, { query: "Matias Icaro" });
  assert.ok(suggestion?.pending);
  for (
    const options of [
      { ownerPhone: "+5492262338010" },
      { conversationId: "d6a6482c-bcee-4880-ad64-602c405d98c4" },
    ]
  ) {
    reads.length = 0;
    const result = await lookup(client, {
      body: "Sí",
      pending: suggestion.pending,
      ...options,
    });
    assert.equal(result, null);
    assert.deepEqual(reads, [], JSON.stringify(options));
  }
  for (
    const now of [
      new Date(suggestion.pending.expiresAt),
      new Date(NOW.getTime() + 11 * 60 * 1000),
    ]
  ) {
    reads.length = 0;
    const result = await lookup(client, {
      body: "Sí",
      pending: suggestion.pending,
      now,
    });
    assert.ok(result);
    assert.equal(result.pending, null);
    assert.match(result.reply, /confirmación venció/);
    assert.deepEqual(reads, []);
  }
});

test("estado incompleto o manipulado nunca habilita una consulta privada", async () => {
  const { client, reads } = fakePatientDirectory();
  const suggestion = await lookup(client, { query: "Matias Icaro" });
  assert.ok(suggestion?.pending);
  for (
    const pending of [
      null,
      "Matias Icardo",
      {},
      { ...suggestion.pending, candidates: [] },
      { ...suggestion.pending, candidates: [{ name: "Matias Icardo" }] },
    ]
  ) {
    reads.length = 0;
    const result = await lookup(client, { body: "Sí", pending });
    assert.equal(result, null);
    assert.deepEqual(reads, []);
  }
  for (
    const invalidTimes of [
      { expiresAt: "invalid" },
      { createdAt: new Date(NOW.getTime() + 60_000).toISOString() },
      { expiresAt: new Date(NOW.getTime() + 11 * 60 * 1000).toISOString() },
    ]
  ) {
    reads.length = 0;
    const result = await lookup(client, {
      body: "Sí",
      pending: { ...suggestion.pending, ...invalidTimes },
    });
    assert.ok(result);
    assert.equal(result.pending, null);
    assert.match(result.reply, /confirmación venció/);
    assert.deepEqual(reads, []);
  }
});

test("una ficha renombrada o eliminada no filtra datos de otra persona al confirmar", async () => {
  for (const change of ["renamed", "deleted"] as const) {
    const { client, reads, tables } = fakePatientDirectory();
    const suggestion = await lookup(client, { query: "Matias Icaro" });
    assert.ok(suggestion?.pending);
    tables.contacts = change === "deleted"
      ? []
      : [contact(MATIAS_ID, "Otra Persona")];
    reads.length = 0;
    const result = await lookup(client, {
      body: "Sí",
      pending: suggestion.pending,
    });
    assert.ok(result);
    assert.equal(result.pending, null);
    assert.doesNotMatch(
      result.reply,
      /Otra Persona|\+5491112345678|Próximo turno:/,
    );
    assert.ok(reads.every((read) => read.table !== "appointments"));
    assertNamesOnly(reads);
  }
});

test("dos IDs con el mismo nombre normalizado nunca se resuelven automáticamente", async () => {
  const { client, reads } = fakePatientDirectory({
    contacts: [contact(), contact(OTHER_ID, "Matías Icardo", "+5491187654321")],
  });
  const result = await lookup(client, { query: "Matias Icardo" });
  assert.ok(result);
  assertNamesOnly(reads);
  assert.doesNotMatch(result.reply, /Teléfono|Cobertura|Próximo turno|\+549/);
});

test("un homónimo fuera de las cinco sugerencias visibles también bloquea una elección insegura", async () => {
  const contacts = [
    "Matias Icardo",
    "Matias Icarlo",
    "Matias Icarno",
    "Matias Icarto",
    "Matias Icarpo",
    "Matías Icardo",
  ].map((name, index) =>
    contact(
      `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      name,
    )
  );
  const { client, reads } = fakePatientDirectory({ contacts });
  const result = await lookup(client, { query: "Matias Icaro" });
  assert.ok(result);
  assert.equal(result.pending, null);
  assertNamesOnly(reads);
  assert.doesNotMatch(result.reply, /Teléfono|Cobertura|Próximo turno|\+549/);
});

test("un homónimo agregado entre la sugerencia y el sí obliga a revisar las fichas", async () => {
  const { client, reads, tables } = fakePatientDirectory();
  const suggestion = await lookup(client, { query: "Matias Icaro" });
  assert.ok(suggestion?.pending);
  tables.contacts.push(contact(OTHER_ID, "Matías Icardo", "+5491187654321"));
  reads.length = 0;
  const result = await lookup(client, {
    body: "Sí",
    pending: suggestion.pending,
  });
  assert.ok(result);
  assert.equal(result.pending, null);
  assertNamesOnly(reads);
  assert.doesNotMatch(result.reply, /Teléfono|Cobertura|Próximo turno|\+549/);
});

test("la búsqueda pagina todos los nombres antes de decidir y no pierde un apellido fuera de la primera página", async () => {
  const contacts = Array.from({ length: 1_000 }, (_, index) =>
    contact(
      `00000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`,
      `Paciente Sin Coincidencia ${index}`,
    ));
  contacts.push(contact("ffffffff-ffff-4fff-8fff-ffffffffffff"));
  const { client, reads } = fakePatientDirectory({ contacts });
  const result = await lookup(client, { query: "Matías Icardo" });
  assert.ok(result);
  assert.match(result.reply, /Matias Icardo/);
  assert.match(result.reply, /Teléfono:/);
  const directoryReads = reads.filter((read) => read.columns === "id,name");
  assert.deepEqual(directoryReads.map((read) => read.range), [[0, 999], [
    1000,
    1999,
  ], [1001, 2000]]);
});

test("un directorio fuera del límite falla cerrado sin asegurar que un nombre sea único", async () => {
  const contacts = Array.from({ length: 10_001 }, (_, index) =>
    contact(
      `00000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`,
      index === 0 ? "Matias Icardo" : `Paciente Sin Coincidencia ${index}`,
    ));
  const { client, reads } = fakePatientDirectory({ contacts });
  await assert.rejects(
    lookup(client, { query: "Matías Icardo" }),
    /OWNER_PATIENT_DIRECTORY_TOO_LARGE/,
  );
  assertNamesOnly(reads);
});

test("errores de base no se presentan como paciente o turno inexistente", async () => {
  for (const fail of ["directory", "contact", "appointments"] as const) {
    const { client } = fakePatientDirectory({ fail });
    await assert.rejects(
      lookup(client, { query: "Matías Icardo" }),
      (error: unknown) => error instanceof Error,
      fail,
    );
  }
});

test("el próximo turno excluye pasado, cancelaciones y reservas vencidas", async () => {
  const { client } = fakePatientDirectory({
    appointments: [
      appointment({ starts_at: "2026-09-07T19:00:00.000Z" }),
      appointment({
        starts_at: "2026-09-08T13:00:00.000Z",
        status: "cancelled",
      }),
      appointment({
        starts_at: "2026-09-09T13:00:00.000Z",
        status: "scheduled",
        deposit_status: "pending",
        hold_expires_at: NOW.toISOString(),
      }),
      appointment({
        starts_at: "2026-09-10T13:00:00.000Z",
        status: "scheduled",
        deposit_status: "proof_received",
        hold_expires_at: null,
      }),
      appointment({
        contact_id: OTHER_ID,
        starts_at: "2026-09-11T13:00:00.000Z",
      }),
      appointment(),
    ],
  });
  const result = await lookup(client, { query: "Matias Icardo" });
  assert.ok(result);
  assert.match(result.reply, /Próximo turno:.*16[/-]9.*20:00/);
});
