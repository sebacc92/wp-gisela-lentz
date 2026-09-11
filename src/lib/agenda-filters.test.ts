import assert from "node:assert/strict";
import test from "node:test";
import {
  activeAgendaFilterCount,
  EMPTY_AGENDA_FILTERS,
  matchesAgendaFilters,
  matchesStatusFilter,
  type AgendaFilterable,
  type AgendaFilters,
} from "./agenda-filters.ts";

function appointment(
  overrides: Partial<AgendaFilterable> = {},
): AgendaFilterable {
  return {
    status: "scheduled",
    depositStatus: "pending",
    coverage: "ioma",
    contactCoverage: "ioma",
    serviceId: "service-1",
    professionalId: "pro-1",
    contactName: "Ana Gómez",
    contactPhone: "+5492211234567",
    serviceName: "Limpieza",
    ...overrides,
  };
}

function filters(overrides: Partial<AgendaFilters> = {}): AgendaFilters {
  return { ...EMPTY_AGENDA_FILTERS, ...overrides };
}

test("sin filtros pasa toda la agenda", () => {
  assert.equal(matchesAgendaFilters(appointment(), filters()), true);
});

test("los criterios se combinan con Y lógico", () => {
  const target = appointment({
    coverage: "particular",
    serviceId: "service-2",
  });
  assert.equal(
    matchesAgendaFilters(
      target,
      filters({ coverage: "particular", serviceId: "service-2" }),
    ),
    true,
  );
  // Cumple la cobertura pero no el motivo: no pasa.
  assert.equal(
    matchesAgendaFilters(
      target,
      filters({ coverage: "particular", serviceId: "service-1" }),
    ),
    false,
  );
});

test("la cobertura cae al contacto cuando el turno no la guardó", () => {
  const legacy = appointment({ coverage: null, contactCoverage: "particular" });
  assert.equal(
    matchesAgendaFilters(legacy, filters({ coverage: "particular" })),
    true,
  );
  assert.equal(
    matchesAgendaFilters(legacy, filters({ coverage: "ioma" })),
    false,
  );
});

test("el snapshot del turno manda sobre la cobertura actual del contacto", () => {
  const moved = appointment({
    coverage: "ioma",
    contactCoverage: "particular",
  });
  assert.equal(
    matchesAgendaFilters(moved, filters({ coverage: "ioma" })),
    true,
    "el turno se atendió como IOMA aunque hoy el paciente sea particular",
  );
});

test("la seña sólo describe turnos vivos", () => {
  const cancelled = appointment({
    status: "cancelled",
    depositStatus: "pending",
  });
  assert.equal(
    matchesAgendaFilters(cancelled, filters({ deposit: "pending" })),
    false,
    "una seña de un turno cancelado ya no se reclama",
  );
});

test("pendiente es una reserva viva esperando seña", () => {
  assert.equal(
    matchesStatusFilter(
      appointment({ status: "scheduled", depositStatus: "pending" }),
      "scheduled",
    ),
    true,
  );
  assert.equal(
    matchesStatusFilter(
      appointment({ status: "scheduled", depositStatus: "expired" }),
      "scheduled",
    ),
    false,
  );
});

test("confirmado se lee del estado visible, no del crudo", () => {
  assert.equal(
    matchesStatusFilter(
      appointment({ status: "scheduled", depositStatus: "confirmed" }),
      "confirmed",
    ),
    true,
  );
  assert.equal(
    matchesStatusFilter(
      appointment({ status: "scheduled", depositStatus: "expired" }),
      "cancelled",
    ),
    true,
    "una pre-reserva vencida se muestra como cancelada",
  );
});

test("la búsqueda mira nombre, teléfono y motivo", () => {
  const target = appointment();
  assert.equal(matchesAgendaFilters(target, filters({ query: "gómez" })), true);
  assert.equal(
    matchesAgendaFilters(target, filters({ query: "1234567" })),
    true,
  );
  assert.equal(matchesAgendaFilters(target, filters({ query: "limp" })), true);
  assert.equal(matchesAgendaFilters(target, filters({ query: "zzz" })), false);
});

test("el profesional filtra por identificador", () => {
  assert.equal(
    matchesAgendaFilters(appointment(), filters({ professionalId: "pro-2" })),
    false,
  );
});

test("se cuentan los criterios puestos", () => {
  assert.equal(activeAgendaFilterCount(filters()), 0);
  assert.equal(
    activeAgendaFilterCount(
      filters({ coverage: "ioma", serviceId: "s", query: "  " }),
    ),
    2,
    "una búsqueda en blanco no es un filtro",
  );
});

test("la búsqueda de la agenda ignora acentos", () => {
  const target = appointment({
    contactName: "Ana Pérez",
    serviceName: "Extracción",
  });
  assert.equal(matchesAgendaFilters(target, filters({ query: "perez" })), true);
  assert.equal(matchesAgendaFilters(target, filters({ query: "PÉREZ" })), true);
  assert.equal(
    matchesAgendaFilters(target, filters({ query: "extraccion" })),
    true,
  );
});
