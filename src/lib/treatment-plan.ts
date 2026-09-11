/**
 * Plan de tratamiento y presupuesto.
 *
 * Es lo que se piensa hacer y cuánto sale: **no es historia clínica**. El
 * odontograma registra hallazgos y es append-only; esto es un presupuesto que
 * cambia, se reordena y se cancela. Marcar un ítem como hecho no escribe nada
 * en el odontograma: eso lo registra la profesional aparte.
 */

export type TreatmentItemStatus =
  | "pending"
  | "in_progress"
  | "done"
  | "cancelled";

export interface TreatmentPlanItem {
  id: string;
  tooth: number | null;
  description: string;
  estimatedCostArs: number | null;
  status: TreatmentItemStatus;
  note: string | null;
  completedAt: string | null;
  createdAt: string;
}

export const TREATMENT_STATUS_LABELS: Record<TreatmentItemStatus, string> = {
  pending: "Pendiente",
  in_progress: "En curso",
  done: "Hecho",
  cancelled: "Cancelado",
};

/**
 * Tono de cada estado. El verde es de **avance de tratamiento**, no del
 * odontograma: la ficha clínica conserva la convención propia del consultorio
 * (caries azul, obturación roja) y este vocabulario no la toca.
 */
export const TREATMENT_STATUS_TONES: Record<TreatmentItemStatus, string> = {
  pending: "neutral",
  in_progress: "progress",
  done: "done",
  cancelled: "cancelled",
};

export interface TreatmentPlanTotals {
  /** Suma de lo que todavía puede ejecutarse. */
  pendingArs: number;
  inProgressArs: number;
  doneArs: number;
  /** Pendiente + en curso: lo que falta cobrar si se hace todo. */
  remainingArs: number;
  /** Todo lo no cancelado. */
  totalArs: number;
  /** Ítems sin precio cargado: no suman y se avisan aparte. */
  withoutCost: number;
  counts: Record<TreatmentItemStatus, number>;
}

function cost(item: TreatmentPlanItem): number | null {
  const value = item.estimatedCostArs;
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

export function treatmentPlanTotals(
  items: readonly TreatmentPlanItem[],
): TreatmentPlanTotals {
  const totals: TreatmentPlanTotals = {
    pendingArs: 0,
    inProgressArs: 0,
    doneArs: 0,
    remainingArs: 0,
    totalArs: 0,
    withoutCost: 0,
    counts: { pending: 0, in_progress: 0, done: 0, cancelled: 0 },
  };

  for (const item of items) {
    totals.counts[item.status] += 1;
    // Un ítem cancelado no cuesta nada ni se reclama.
    if (item.status === "cancelled") continue;

    const value = cost(item);
    if (value === null) {
      totals.withoutCost += 1;
      continue;
    }

    if (item.status === "pending") totals.pendingArs += value;
    else if (item.status === "in_progress") totals.inProgressArs += value;
    else totals.doneArs += value;
  }

  totals.remainingArs = totals.pendingArs + totals.inProgressArs;
  totals.totalArs = totals.remainingArs + totals.doneArs;
  return totals;
}

/** Porcentaje de avance por ítems cerrados, o `null` si no hay plan activo. */
export function treatmentProgress(
  items: readonly TreatmentPlanItem[],
): number | null {
  const active = items.filter((item) => item.status !== "cancelled");
  if (active.length === 0) return null;
  const done = active.filter((item) => item.status === "done").length;
  return Math.round((done / active.length) * 100);
}

export function formatArs(value: number): string {
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    maximumFractionDigits: 0,
  }).format(value);
}

/**
 * Propone ítems a partir de los hallazgos del odontograma.
 *
 * Sugiere, no decide: sólo mira condiciones que habitualmente requieren
 * trabajo y deja el precio vacío para que lo ponga quien presupuesta.
 */
const SUGGESTED_BY_CONDITION: Record<string, string> = {
  caries: "Obturación",
  fracturado: "Restauración de pieza fracturada",
  extraccion_indicada: "Extracción",
};

export interface TreatmentSuggestion {
  tooth: number;
  description: string;
}

export function suggestTreatmentItems(
  findings: readonly { tooth: number; condition: string }[],
  existing: readonly TreatmentPlanItem[] = [],
): TreatmentSuggestion[] {
  const alreadyPlanned = new Set(
    existing
      .filter((item) => item.status !== "cancelled" && item.tooth !== null)
      .map((item) => `${item.tooth}:${item.description}`),
  );

  const suggestions: TreatmentSuggestion[] = [];
  const seen = new Set<string>();
  for (const finding of findings) {
    const description = SUGGESTED_BY_CONDITION[finding.condition];
    if (!description) continue;
    const key = `${finding.tooth}:${description}`;
    if (seen.has(key) || alreadyPlanned.has(key)) continue;
    seen.add(key);
    suggestions.push({ tooth: finding.tooth, description });
  }
  return suggestions.sort((a, b) => a.tooth - b.tooth);
}
