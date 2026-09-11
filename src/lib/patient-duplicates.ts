/**
 * Detección de pacientes duplicados.
 *
 * Un mismo paciente puede entrar dos veces: escribió desde otro teléfono, el
 * nombre vino con acento o sin él, o alguien lo cargó a mano mientras el bot
 * ya lo había creado.
 *
 * La detección es deliberadamente conservadora. Un falso positivo hace perder
 * tiempo; un falso negativo sólo deja dos fichas. Fusionar es lo caro y no
 * siempre reversible, así que acá sólo se **propone**: la decisión es de una
 * persona.
 */

export interface DuplicateCandidateInput {
  id: string;
  name: string;
  phoneE164: string | null;
  alternatePhoneE164: string | null;
  createdAt: string;
  /** Turnos asociados: desempata cuál ficha conviene conservar. */
  appointmentCount: number;
  /** Si tiene historia clínica cargada. Bloquea la fusión. */
  hasClinicalHistory: boolean;
}

export type DuplicateReason = "same_phone" | "same_name" | "similar_name";

export interface DuplicatePair {
  primary: DuplicateCandidateInput;
  duplicate: DuplicateCandidateInput;
  reason: DuplicateReason;
  /** 0-100. Sólo ordena la lista; no autoriza nada por sí solo. */
  confidence: number;
}

export function normalizeName(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("es-AR")
    .replace(/[^a-z0-9 ]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Últimos dígitos, que es lo que sobrevive a prefijos y al 9 de Argentina. */
function phoneKey(value: string | null): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, "");
  return digits.length >= 8 ? digits.slice(-8) : null;
}

function phoneKeys(candidate: DuplicateCandidateInput): string[] {
  return [
    phoneKey(candidate.phoneE164),
    phoneKey(candidate.alternatePhoneE164),
  ].filter((value): value is string => value !== null);
}

/** Nombres iguales con las palabras en otro orden: "Ana Gómez" / "Gómez Ana". */
function sameWords(a: string, b: string): boolean {
  const wordsA = a.split(" ").filter(Boolean).sort().join(" ");
  const wordsB = b.split(" ").filter(Boolean).sort().join(" ");
  return wordsA.length > 0 && wordsA === wordsB;
}

/**
 * Cuál de las dos fichas conviene conservar: la que tiene más turnos y, a
 * igualdad, la más antigua. Es la que probablemente ya esté referenciada.
 */
function pickPrimary(
  a: DuplicateCandidateInput,
  b: DuplicateCandidateInput,
): [DuplicateCandidateInput, DuplicateCandidateInput] {
  if (a.appointmentCount !== b.appointmentCount) {
    return a.appointmentCount > b.appointmentCount ? [a, b] : [b, a];
  }
  return Date.parse(a.createdAt) <= Date.parse(b.createdAt) ? [a, b] : [b, a];
}

export function findDuplicatePairs(
  candidates: readonly DuplicateCandidateInput[],
): DuplicatePair[] {
  const pairs: DuplicatePair[] = [];

  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      const a = candidates[i];
      const b = candidates[j];

      const keysA = phoneKeys(a);
      const keysB = phoneKeys(b);
      const sharesPhone = keysA.some((key) => keysB.includes(key));

      const nameA = normalizeName(a.name);
      const nameB = normalizeName(b.name);
      const identicalName = nameA.length > 0 && nameA === nameB;
      const reorderedName = !identicalName && sameWords(nameA, nameB);

      let reason: DuplicateReason | null = null;
      let confidence = 0;

      if (sharesPhone) {
        reason = "same_phone";
        // El teléfono es el identificador fuerte; el nombre igual lo refuerza.
        confidence = identicalName ? 98 : 90;
      } else if (identicalName) {
        reason = "same_name";
        confidence = 70;
      } else if (reorderedName) {
        reason = "similar_name";
        confidence = 60;
      }

      if (!reason) continue;

      const [primary, duplicate] = pickPrimary(a, b);
      pairs.push({ primary, duplicate, reason, confidence });
    }
  }

  return pairs.sort((x, y) => y.confidence - x.confidence);
}

export const DUPLICATE_REASON_LABELS: Record<DuplicateReason, string> = {
  same_phone: "Comparten teléfono",
  same_name: "Mismo nombre",
  similar_name: "Nombre con las palabras en otro orden",
};

export interface MergeBlock {
  blocked: boolean;
  reason: string | null;
}

/**
 * Si la fusión se puede hacer desde el panel.
 *
 * Una ficha con historia clínica no se fusiona acá: el odontograma es
 * append-only por la ley 26.529 y reasignar asientos clínicos a otro paciente
 * no es una operación administrativa. Esos casos se resuelven a mano.
 */
export function mergeBlock(pair: DuplicatePair): MergeBlock {
  if (pair.duplicate.hasClinicalHistory) {
    return {
      blocked: true,
      reason:
        "La ficha a fusionar tiene odontograma cargado. La historia clínica no se puede reasignar desde acá.",
    };
  }
  if (pair.primary.id === pair.duplicate.id) {
    return { blocked: true, reason: "Es la misma ficha." };
  }
  return { blocked: false, reason: null };
}
