/**
 * Resultados de la búsqueda global (Ctrl/⌘ + K).
 *
 * La parte pura vive acá: qué se muestra, en qué orden y a dónde lleva cada
 * resultado. La consulta a Supabase queda aparte para poder probar esto sin
 * base, y por eso el módulo no conoce la zona horaria del consultorio: quien
 * llama le pasa la fecha calendario ya resuelta.
 */

export type GlobalSearchKind = "patient" | "conversation" | "appointment";

export interface GlobalSearchResult {
  kind: GlobalSearchKind;
  id: string;
  title: string;
  subtitle: string;
  href: string;
  /** ISO del turno, cuando aplica: ordena por cercanía. */
  startsAt?: string;
}

export const GLOBAL_SEARCH_MIN_LENGTH = 2;

export const KIND_LABELS: Record<GlobalSearchKind, string> = {
  patient: "Pacientes",
  conversation: "Conversaciones",
  appointment: "Turnos",
};

export function patientHref(contactId: string): string {
  return `/app/patients?patient=${encodeURIComponent(contactId)}`;
}

export function conversationHref(conversationId: string): string {
  return `/app/inbox?conversation=${encodeURIComponent(conversationId)}`;
}

export function appointmentHref(
  appointmentId: string,
  /** Fecha calendario del consultorio, `YYYY-MM-DD`. */
  date: string,
): string {
  return `/app/appointments?date=${date}&appointment=${encodeURIComponent(appointmentId)}`;
}

/**
 * Un turno próximo importa más que uno viejo, y el pasado se ordena del más
 * reciente hacia atrás: buscar a alguien suele ser para ver qué viene, o qué
 * pasó recién.
 */
export function compareAppointments(
  a: { startsAt?: string },
  b: { startsAt?: string },
  now = Date.now(),
): number {
  const timeA = a.startsAt ? Date.parse(a.startsAt) : Number.NaN;
  const timeB = b.startsAt ? Date.parse(b.startsAt) : Number.NaN;
  if (Number.isNaN(timeA) && Number.isNaN(timeB)) return 0;
  if (Number.isNaN(timeA)) return 1;
  if (Number.isNaN(timeB)) return -1;

  const futureA = timeA >= now;
  const futureB = timeB >= now;
  if (futureA !== futureB) return futureA ? -1 : 1;
  // Entre futuros, primero el más cercano; entre pasados, el más reciente.
  return futureA ? timeA - timeB : timeB - timeA;
}

/** Agrupa conservando el orden de cada grupo. */
export function groupResults(
  results: readonly GlobalSearchResult[],
): Array<{ kind: GlobalSearchKind; items: GlobalSearchResult[] }> {
  const order: GlobalSearchKind[] = ["patient", "appointment", "conversation"];
  return order
    .map((kind) => ({
      kind,
      items: results.filter((result) => result.kind === kind),
    }))
    .filter((group) => group.items.length > 0);
}
