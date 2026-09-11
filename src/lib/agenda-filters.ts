import { appointmentDisplayStatus, type AppointmentStatus } from "./booking.ts";
import type { DepositStatus, PatientCoverage } from "./inbox-types";
import { foldForSearch } from "./message-search.ts";

/**
 * Filtros combinables de la agenda.
 *
 * Cada criterio se aplica con Y lógico: la agenda muestra lo que cumple todo
 * lo elegido. Un criterio vacío no filtra, así que el estado por defecto
 * —todo vacío— deja pasar la agenda completa.
 *
 * La lógica vive acá y no en la pantalla porque el estado de un turno no es un
 * campo: "Confirmado" puede venir del estado del turno o de la seña, y esa
 * equivalencia tiene que ser la misma para el filtro, para el listado y para
 * lo que se imprime.
 */

export interface AgendaFilterable {
  status: AppointmentStatus;
  depositStatus: DepositStatus;
  coverage: PatientCoverage | null;
  contactCoverage: PatientCoverage | null;
  serviceId: string | null;
  professionalId: string;
  contactName: string;
  contactPhone: string;
  serviceName: string;
}

export interface AgendaFilters {
  query: string;
  status: AppointmentStatus | "";
  deposit: DepositStatus | "";
  coverage: PatientCoverage | "";
  serviceId: string;
  professionalId: string;
}

export const EMPTY_AGENDA_FILTERS: AgendaFilters = {
  query: "",
  status: "",
  deposit: "",
  coverage: "",
  serviceId: "",
  professionalId: "",
};

function displayStatus(appointment: AgendaFilterable): string {
  return appointmentDisplayStatus(
    appointment.status,
    appointment.depositStatus,
  );
}

/**
 * Conserva la equivalencia que ya usaba la agenda: "pendiente" es una reserva
 * viva esperando seña, y "confirmado"/"cancelado" se leen del estado que ve el
 * usuario, no del crudo de la base.
 */
export function matchesStatusFilter(
  appointment: AgendaFilterable,
  filter: AppointmentStatus | "",
): boolean {
  if (!filter) return true;
  if (filter === "scheduled") {
    return (
      appointment.status === "scheduled" &&
      (appointment.depositStatus === "pending" ||
        appointment.depositStatus === "proof_received")
    );
  }
  if (filter === "confirmed")
    return displayStatus(appointment) === "Confirmado";
  if (filter === "cancelled") return displayStatus(appointment) === "Cancelado";
  return appointment.status === filter;
}

/** Sin acentos: «perez» encuentra a «Pérez», como se escribe en el celular. */
function matchesQuery(appointment: AgendaFilterable, query: string): boolean {
  const normalized = foldForSearch(query.trim());
  if (!normalized) return true;
  return (
    foldForSearch(appointment.contactName).includes(normalized) ||
    appointment.contactPhone.includes(normalized) ||
    foldForSearch(appointment.serviceName).includes(normalized)
  );
}

/**
 * La seña sólo describe turnos vivos. Pedir "esperando seña" sobre un turno
 * cancelado devolvería registros que ya no hay que reclamar.
 */
function matchesDeposit(
  appointment: AgendaFilterable,
  deposit: DepositStatus | "",
): boolean {
  if (!deposit) return true;
  return (
    (appointment.status === "scheduled" ||
      appointment.status === "confirmed") &&
    appointment.depositStatus === deposit
  );
}

/**
 * El turno guarda un snapshot de cobertura al reservarse; el contacto puede
 * haber cambiado después. Se acepta cualquiera de los dos para que un cambio
 * administrativo posterior no esconda el turno.
 */
function matchesCoverage(
  appointment: AgendaFilterable,
  coverage: PatientCoverage | "",
): boolean {
  if (!coverage) return true;
  return (
    appointment.coverage === coverage ||
    (appointment.coverage === null && appointment.contactCoverage === coverage)
  );
}

export function matchesAgendaFilters(
  appointment: AgendaFilterable,
  filters: AgendaFilters,
): boolean {
  return (
    matchesQuery(appointment, filters.query) &&
    matchesStatusFilter(appointment, filters.status) &&
    matchesDeposit(appointment, filters.deposit) &&
    matchesCoverage(appointment, filters.coverage) &&
    (!filters.serviceId || appointment.serviceId === filters.serviceId) &&
    (!filters.professionalId ||
      appointment.professionalId === filters.professionalId)
  );
}

/** Cuántos criterios están puestos, para avisarlo en el botón de filtros. */
export function activeAgendaFilterCount(filters: AgendaFilters): number {
  return (
    (filters.query.trim() ? 1 : 0) +
    (filters.status ? 1 : 0) +
    (filters.deposit ? 1 : 0) +
    (filters.coverage ? 1 : 0) +
    (filters.serviceId ? 1 : 0) +
    (filters.professionalId ? 1 : 0)
  );
}
