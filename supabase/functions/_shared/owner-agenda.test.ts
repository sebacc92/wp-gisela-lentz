import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.112.2";
import { detectOwnerRequest } from "./owner-access.ts";
import { loadOwnerAgenda } from "./owner-agenda.ts";

const NOW = new Date("2026-09-07T15:00:00.000Z"); // Lunes, 12:00 en Buenos Aires.
type Row = Record<string, unknown>;

function appointment(name: string, startsAt: string, overrides: Row = {}): Row {
  return {
    starts_at: startsAt,
    status: "confirmed",
    hold_expires_at: null,
    coverage: "particular",
    deposit_status: "not_required",
    contacts: { name },
    ...overrides,
  };
}

const APPOINTMENTS = [
  appointment("Pasado hoy", "2026-09-07T14:59:00.000Z"),
  appointment("Futuro hoy", "2026-09-07T16:00:00.000Z"),
  appointment("Paciente mañana", "2026-09-08T13:30:00.000Z"),
  appointment("Miércoles tarde", "2026-09-10T02:59:00.000Z"),
  appointment("Jueves inicio", "2026-09-10T03:00:00.000Z"),
  appointment("Jueves consulta", "2026-09-10T13:30:00.000Z"),
  appointment("Reserva vigente", "2026-09-10T15:00:00.000Z", {
    status: "scheduled",
    deposit_status: "pending",
    hold_expires_at: "2026-09-07T16:00:00.000Z",
  }),
  appointment("Cancelado", "2026-09-10T16:00:00.000Z", {
    status: "cancelled",
  }),
  appointment("Reserva vencida", "2026-09-10T17:00:00.000Z", {
    status: "scheduled",
    deposit_status: "pending",
    hold_expires_at: NOW.toISOString(),
  }),
  appointment("Comprobante vencido", "2026-09-10T17:30:00.000Z", {
    status: "scheduled",
    deposit_status: "proof_received",
    hold_expires_at: "2026-09-07T14:59:00.000Z",
  }),
  appointment("Reserva sin vencimiento", "2026-09-10T18:00:00.000Z", {
    status: "scheduled",
    deposit_status: "pending",
  }),
  appointment("Jueves cierre", "2026-09-11T02:59:00.000Z"),
  appointment("Viernes inicio", "2026-09-11T03:00:00.000Z"),
  appointment("Mes siguiente", "2026-10-08T14:00:00.000Z"),
];

function compare(row: Row, column: string, expected: unknown): number {
  const actual = row[column];
  if (column.endsWith("_at")) {
    return Date.parse(String(actual)) - Date.parse(String(expected));
  }
  if (actual === expected) return 0;
  return String(actual) < String(expected) ? -1 : 1;
}

/** Interpreta las condiciones OR para que quitar o romper el filtro de reservas
 * cambie el resultado, incluso cuando la consulta alcanza su límite de filas. */
function orCondition(expression: string): (row: Row) => boolean {
  const expressions = expression.split(/,(?![^()]*\))/);
  const conditions = expressions.map((part) => {
    const match = part.match(/^([a-z_]+)\.(eq|gt|not\.in)\.(.+)$/);
    assert.ok(match, `Condición OR no soportada: ${part}`);
    const [, column, operator, value] = match;
    if (operator === "eq") return (row: Row) => row[column] === value;
    if (operator === "gt")
      return (row: Row) =>
        row[column] != null && compare(row, column, value) > 0;
    assert.match(value, /^\([^()]+\)$/);
    const excluded = value.slice(1, -1).split(",");
    return (row: Row) =>
      row[column] != null && !excluded.includes(String(row[column]));
  });
  return (row) => conditions.some((condition) => condition(row));
}

/** Base en memoria que realmente filtra, ordena y limita los resultados. */
function fakeAgenda(
  input: {
    appointments?: Row[];
    blocks?: Row[];
    errorTable?: string;
  } = {},
) {
  const tables: Record<string, Row[]> = {
    appointments: input.appointments ?? APPOINTMENTS,
    google_calendar_connections: [
      {
        id: true,
        status: "connected",
        connection_generation: 2,
        last_sync_completed_at: NOW.toISOString(),
      },
    ],
    google_calendar_external_events: input.blocks ?? [],
  };
  const returned: Record<string, number> = {};
  const client = {
    from(table: string) {
      assert.ok(table in tables, `Tabla inesperada: ${table}`);
      const filters: Array<(row: Row) => boolean> = [];
      let order: string | undefined;
      let limit = Infinity;
      const result = () => {
        if (input.errorTable === table)
          return {
            data: null,
            error: { message: "Error de consulta simulado" },
          };
        let rows = tables[table].filter((row) =>
          filters.every((filter) => filter(row)),
        );
        if (order) {
          const column = order;
          rows.sort((a, b) => compare(a, column, b[column]));
        }
        rows = rows.slice(0, limit);
        returned[table] = rows.length;
        return { data: rows, error: null };
      };
      const query = {
        select() {
          return query;
        },
        eq(column: string, value: unknown) {
          filters.push((row) => row[column] === value);
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
        gt(column: string, value: unknown) {
          filters.push((row) => compare(row, column, value) > 0);
          return query;
        },
        lt(column: string, value: unknown) {
          filters.push((row) => compare(row, column, value) < 0);
          return query;
        },
        or(expression: string) {
          filters.push(orCondition(expression));
          return query;
        },
        order(column: string) {
          order = column;
          return query;
        },
        limit(count: number) {
          limit = count;
          return query;
        },
        async maybeSingle() {
          const response = result();
          return { ...response, data: response.data?.[0] ?? null };
        },
        then(resolve: (value: unknown) => unknown) {
          return Promise.resolve(result()).then(resolve);
        },
      };
      return query;
    },
  } as unknown as SupabaseClient;
  return { client, returned };
}

async function answer(body: string, client: SupabaseClient) {
  const request = detectOwnerRequest(body, NOW);
  assert.equal(request?.kind, "agenda", body);
  assert.ok(request?.kind === "agenda");
  return loadOwnerAgenda({ client, day: request.day, now: NOW });
}

test("el pedido real del jueves devuelve ese día de Buenos Aires y no hoy", async () => {
  const { client } = fakeAgenda();
  assert.deepEqual(detectOwnerRequest("Dame los turnos del jueves", NOW), {
    kind: "agenda",
    day: { date: "2026-09-10" },
  });
  const body = await answer("Dame los turnos del jueves", client);
  assert.match(body, /^Turnos del jueves,? 10[/-]9:/);
  assert.match(body, /00:00 · Jueves inicio/);
  assert.match(body, /10:30 · Jueves consulta/);
  assert.match(body, /12:00 · Reserva vigente · Particular — esperando seña/);
  assert.match(body, /23:59 · Jueves cierre/);
  assert.match(body, /4 turnos\./);
  assert.doesNotMatch(
    body,
    /hoy|mañana|Miércoles tarde|Viernes inicio|Mes siguiente|Cancelado|vencid|sin vencimiento|Google Calendar necesita/,
  );
});

test("próximos turnos todos incluye el mes siguiente y agrupa cada fecha", async () => {
  const { client } = fakeAgenda();
  assert.deepEqual(detectOwnerRequest("Dame los próximos turnos todos", NOW), {
    kind: "agenda",
    day: "upcoming",
  });
  const body = await answer("Dame los próximos turnos todos", client);
  assert.match(body, /^Próximos turnos:/);
  // ICU cambia la puntuación entre versiones de Node; el día, fecha y salto
  // de línea de cada grupo deben seguir siendo los mismos.
  for (const date of [
    /\nlunes,? 7[/-]9\n/,
    /\nmartes,? 8[/-]9\n/,
    /\nmiércoles,? 9[/-]9\n/,
    /\njueves,? 10[/-]9\n/,
    /\nviernes,? 11[/-]9\n/,
    /\njueves,? 8[/-]10\n/,
  ])
    assert.match(body, date);
  for (const name of ["Futuro hoy", "Paciente mañana", "Mes siguiente"])
    assert.ok(body.includes(name), body);
  assert.match(body, /jueves,? 8[/-]10\n11:00 · Mes siguiente/);
  assert.match(body, /9 turnos\./);
  assert.doesNotMatch(
    body,
    /Pasado hoy|Cancelado|Reserva vencida|Comprobante vencido|Reserva sin vencimiento/,
  );
  assert.ok(body.indexOf("Futuro hoy") < body.indexOf("Mes siguiente"));
});

test("un día sin turnos se explica una vez y no agrega un total de cero", async () => {
  const { client } = fakeAgenda();
  const body = await answer("Dame los turnos del sábado", client);
  assert.match(
    body,
    /^Turnos del sábado,? 12[/-]9: sin turnos cargados en el sistema\.$/,
  );
  assert.doesNotMatch(body, /0 turnos/);
});

test("muestra hasta tres bloqueos actuales y anuncia cuántos se omitieron", async () => {
  const block = (hour: number, overrides: Row = {}): Row => ({
    kind: "block",
    status: "active",
    starts_at: `2026-09-10T${hour}:00:00.000Z`,
    ends_at: `2026-09-10T${hour + 1}:00:00.000Z`,
    all_day: false,
    connection_generation: 2,
    ...overrides,
  });
  const { client } = fakeAgenda({
    appointments: [],
    blocks: [
      ...[12, 13, 14, 15, 16].map((hour) => block(hour)),
      block(17, { status: "cancelled" }),
      block(18, { connection_generation: 1 }),
      block(19, { kind: "appointment" }),
      block(20, {
        starts_at: "2026-09-11T03:00:00.000Z",
        ends_at: "2026-09-11T04:00:00.000Z",
      }),
    ],
  });
  const body = await answer("Dame los turnos del jueves", client);
  assert.equal(body.match(/· Ocupado/g)?.length, 3);
  assert.match(body, /09:00–10:00 · Ocupado/);
  assert.match(body, /11:00–12:00 · Ocupado/);
  assert.match(body, /\+ 2 horarios más en \/app\./);
  assert.doesNotMatch(body, /12:00–13:00|14:00–15:00|0 turnos/);
});

test("un fallo de consulta nunca se presenta como una agenda vacía", async () => {
  for (const errorTable of [
    "appointments",
    "google_calendar_connections",
    "google_calendar_external_events",
  ]) {
    const { client } = fakeAgenda({ errorTable });
    await assert.rejects(
      answer("Dame los turnos del jueves", client),
      /OWNER_AGENDA_UNAVAILABLE/,
      errorTable,
    );
  }
});

test("el límite de consulta avisa que faltan turnos y descarta reservas vencidas antes del corte", async () => {
  const future = Array.from({ length: 102 }, (_, index) =>
    appointment(
      `Paciente ${String(index + 1).padStart(3, "0")}`,
      new Date(
        Date.parse("2026-09-08T13:00:00Z") + index * 60_000,
      ).toISOString(),
      { coverage: null },
    ),
  );
  const expired = Array.from({ length: 102 }, (_, index) =>
    appointment(`Vencido ${index}`, "2026-09-07T16:00:00.000Z", {
      status: "scheduled",
      deposit_status: "pending",
      hold_expires_at: NOW.toISOString(),
    }),
  );
  const { client, returned } = fakeAgenda({
    appointments: [...expired, ...future].reverse(),
  });
  const body = await answer("Dame los próximos turnos todos", client);
  assert.equal(returned.appointments, 101);
  assert.match(body, /Paciente 001/);
  assert.match(body, /Paciente 100/);
  assert.match(body, /Hay más turnos.*agenda completa en \/app\./);
  assert.doesNotMatch(body, /Vencido|Paciente 101|Paciente 102|100 turnos\./);
  assert.ok(body.length <= 4096, String(body.length));
});
