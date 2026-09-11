/**
 * Utilidades de búsqueda de texto: nombres, mensajes y recortes de contexto.
 *
 * Todo ignora acentos, porque en el celular casi nadie los escribe. En el
 * servidor se usa `imatch` con `accentInsensitivePattern`; en el navegador se
 * compara con `foldForSearch`.
 */

/** Mínimo para buscar: menos que esto devuelve medio historial. */
export const MESSAGE_SEARCH_MIN_LENGTH = 3;

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
  const needle = foldForSearch(query.trim());
  // `foldForSearch` conserva la longitud: la posición hallada en el texto
  // plegado es la misma en el original, aunque tenga acentos o emojis.
  const index = needle ? foldForSearch(normalized).indexOf(needle) : -1;
  if (index < 0) {
    return normalized.length > radius * 2
      ? `${normalized.slice(0, radius * 2)}…`
      : normalized;
  }

  const start = Math.max(0, index - radius);
  const end = Math.min(normalized.length, index + needle.length + radius);
  return `${start > 0 ? "…" : ""}${normalized.slice(start, end)}${
    end < normalized.length ? "…" : ""
  }`;
}

/**
 * Patrón de búsqueda que ignora acentos, para `imatch` de PostgREST.
 *
 * `ilike` distingue «López» de «Lopez», y en el celular casi nadie escribe
 * los acentos: buscar «Perez» no encontraba a «Pérez». Cada letra se cambia
 * por una clase con sus variantes, así «lopez» y «lópez» encuentran lo mismo,
 * escriba quien escriba con o sin tilde.
 *
 * Deja sólo letras, dígitos y espacios. Un nombre no necesita puntuación para
 * encontrarse, y así la expresión nunca lleva caracteres que PostgREST o la
 * regex de Postgres interpreten de otra manera.
 */
const ACCENT_CLASSES: Record<string, string> = {
  a: "[aáàâä]",
  e: "[eéèêë]",
  i: "[iíìîï]",
  o: "[oóòôö]",
  u: "[uúùûü]",
  n: "[nñ]",
  c: "[cç]",
};

export function accentInsensitivePattern(
  query: string,
  minLength = MESSAGE_SEARCH_MIN_LENGTH,
): string | null {
  const base = query
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLocaleLowerCase("es-AR")
    .replace(/[^a-z0-9 ]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
  if (base.length < minLength) return null;
  return Array.from(base, (char) =>
    char === " " ? "[ ]" : (ACCENT_CLASSES[char] ?? char),
  ).join("");
}

/**
 * Pasa un texto a minúsculas y sin acentos, **conservando la longitud**.
 *
 * Sirve para comparar lo que se escribe en un buscador contra nombres y
 * mensajes: «perez» tiene que encontrar «Pérez». Se procesa de a una unidad
 * UTF-16 para que cada posición del resultado siga siendo la misma del
 * original; así el recorte de contexto puede buscar en el texto plegado y
 * cortar el original en el mismo lugar, aunque haya emojis de por medio.
 */
export function foldForSearch(value: string): string {
  let folded = "";
  for (let index = 0; index < value.length; index += 1) {
    const unit = value[index];
    const plain = unit
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLocaleLowerCase("es-AR");
    folded += plain.length === 1 ? plain : unit;
  }
  return folded;
}
