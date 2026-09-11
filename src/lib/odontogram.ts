export type ToothCondition =
  | "sano"
  | "caries"
  | "obturado"
  | "sellante"
  | "fracturado"
  | "endodoncia"
  | "corona"
  | "protesis"
  | "implante"
  | "extraccion_indicada"
  | "ausente";

export type ToothSurface =
  | "oclusal"
  | "mesial"
  | "distal"
  | "vestibular"
  | "palatina_lingual";

export interface OdontogramEntry {
  id: string;
  contactId: string;
  tooth: number;
  condition: ToothCondition;
  surfaces: Partial<Record<ToothSurface, ToothCondition>>;
  note: string | null;
  recordedAt: string;
  entrySequence: number;
}

export const CONDITION_LABELS: Record<ToothCondition, string> = {
  sano: "Sana",
  caries: "Caries",
  obturado: "Obturada",
  sellante: "Sellante",
  fracturado: "Fracturada",
  endodoncia: "Endodoncia",
  corona: "Corona",
  protesis: "Prótesis",
  implante: "Implante",
  extraccion_indicada: "Extracción indicada",
  ausente: "Ausente",
};

/** Hallazgos que se localizan en una cara concreta. El resto describe la pieza
 * entera: una corona o una ausencia no tienen cara. */
export const SURFACE_CONDITIONS: ToothCondition[] = [
  "caries",
  "obturado",
  "sellante",
  "fracturado",
];

/** Una pieza que no está, o que es prótesis o implante, no tiene caras que
 * describir; una sana no tiene hallazgos. Coincide con el check de la base. */
export function conditionAllowsSurfaces(condition: ToothCondition): boolean {
  return !["ausente", "implante", "protesis", "sano"].includes(condition);
}

// Vista del profesional frente al paciente: a la izquierda de la pantalla
// queda el lado derecho del paciente, así que cada fila abre por el cuadrante
// más alto y baja hasta la línea media.
export const UPPER_PERMANENT = [
  18, 17, 16, 15, 14, 13, 12, 11, 21, 22, 23, 24, 25, 26, 27, 28,
];
export const LOWER_PERMANENT = [
  48, 47, 46, 45, 44, 43, 42, 41, 31, 32, 33, 34, 35, 36, 37, 38,
];
export const UPPER_PRIMARY = [55, 54, 53, 52, 51, 61, 62, 63, 64, 65];
export const LOWER_PRIMARY = [85, 84, 83, 82, 81, 71, 72, 73, 74, 75];

export const ALL_TEETH = [
  ...UPPER_PERMANENT,
  ...LOWER_PERMANENT,
  ...UPPER_PRIMARY,
  ...LOWER_PRIMARY,
];

export function isValidTooth(tooth: number): boolean {
  return ALL_TEETH.includes(tooth);
}

export function isUpperTooth(tooth: number): boolean {
  const quadrant = Math.floor(tooth / 10);
  return quadrant === 1 || quadrant === 2 || quadrant === 5 || quadrant === 6;
}

export function isPrimaryTooth(tooth: number): boolean {
  return tooth >= 51;
}

/** La misma cara se llama palatina arriba y lingual abajo. Se guarda con un
 * único valor y se nombra según la arcada al mostrarla. */
/**
 * Piezas anteriores: incisivos y caninos, posiciones 1 a 3 de cada cuadrante
 * en la numeración FDI. No tienen cara oclusal sino borde incisal.
 */
export function isAnteriorTooth(tooth: number): boolean {
  const position = tooth % 10;
  return position >= 1 && position <= 3;
}

/**
 * La cara central se guarda siempre como `oclusal`, pero se nombra según la
 * pieza: en un molar o un premolar es la cara oclusal; en un incisivo o un
 * canino es el borde incisal. Es el mismo criterio que ya se usa con
 * `palatina_lingual`, que cambia de nombre según la arcada sin duplicar el
 * vocabulario guardado.
 */
export function surfaceLabel(tooth: number, surface: ToothSurface): string {
  switch (surface) {
    case "oclusal":
      return isAnteriorTooth(tooth) ? "Incisal" : "Oclusal";
    case "mesial":
      return "Mesial";
    case "distal":
      return "Distal";
    case "vestibular":
      return "Vestibular";
    case "palatina_lingual":
      return isUpperTooth(tooth) ? "Palatina" : "Lingual";
  }
}

export const ALL_SURFACES: ToothSurface[] = [
  "oclusal",
  "mesial",
  "distal",
  "vestibular",
  "palatina_lingual",
];

/**
 * Resume una pieza en una línea para la ficha. Devuelve la condición y, si
 * las tiene, las caras afectadas, para que no haya que abrir cada pieza.
 */
export function toothSummary(entry: OdontogramEntry | undefined): string {
  if (!entry) return "Sin registrar";
  const label = CONDITION_LABELS[entry.condition];
  const surfaces = ALL_SURFACES.filter((surface) => entry.surfaces?.[surface]);
  if (!surfaces.length) return label;
  return `${label} · ${surfaces
    .map((surface) => {
      const finding = entry.surfaces[surface];
      return `${surfaceLabel(entry.tooth, surface)}${finding && finding !== entry.condition ? `: ${CONDITION_LABELS[finding]}` : ""}`;
    })
    .join(", ")}`;
}

/** El estado vigente es el último asiento de cada pieza. La corrección de un
 * registro clínico agrega, nunca reemplaza. */
export function currentByTooth(
  entries: OdontogramEntry[],
): Map<number, OdontogramEntry> {
  const current = new Map<number, OdontogramEntry>();
  for (const entry of entries) {
    const existing = current.get(entry.tooth);
    if (!existing || entry.entrySequence > existing.entrySequence) {
      current.set(entry.tooth, entry);
    }
  }
  return current;
}
