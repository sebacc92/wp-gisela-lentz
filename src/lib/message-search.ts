/**
 * Búsqueda dentro del texto de los mensajes.
 *
 * `ilike` trata `%` y `_` como comodines, así que un paciente que escribe
 * "50% de descuento" o "turno_1" buscaría cualquier cosa si el texto entrara
 * crudo. Acá se escapan antes de armar el patrón.
 */

/** Mínimo para buscar: menos que esto devuelve medio historial. */
export const MESSAGE_SEARCH_MIN_LENGTH = 3;

export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

export function messageSearchPattern(query: string): string | null {
  const trimmed = query.trim();
  if (trimmed.length < MESSAGE_SEARCH_MIN_LENGTH) return null;
  return `%${escapeLikePattern(trimmed)}%`;
}

/**
 * Recorte alrededor de la coincidencia, para ver el contexto sin traer el
 * mensaje entero a la lista de resultados.
 */
export function messageSnippet(
  body: string,
  query: string,
  radius = 60,
): string {
  const normalized = body.replace(/\s+/g, " ").trim();
  const index = normalized
    .toLocaleLowerCase("es-AR")
    .indexOf(query.trim().toLocaleLowerCase("es-AR"));
  if (index < 0) {
    return normalized.length > radius * 2
      ? `${normalized.slice(0, radius * 2)}…`
      : normalized;
  }

  const start = Math.max(0, index - radius);
  const end = Math.min(normalized.length, index + query.trim().length + radius);
  return `${start > 0 ? "…" : ""}${normalized.slice(start, end)}${
    end < normalized.length ? "…" : ""
  }`;
}
