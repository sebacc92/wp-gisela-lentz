import {
  isUpperTooth,
  isValidTooth,
  type OdontogramEntry,
  type ToothCondition,
  type ToothSurface,
} from "./odontogram.ts";

export const NOTATION_COLORS = {
  blue: "#1d4ed8",
  red: "#b91c1c",
  neutral: "#596270",
} as const;

export interface ConditionNotation {
  tone: keyof typeof NOTATION_COLORS;
  symbol:
    | "caries"
    | "restoration"
    | "extraction"
    | "missing"
    | "healthy"
    | "unrecorded"
    | "label";
  description: string;
}

/** Convención solicitada por Gisela para su ficha. No clasifica tratamientos
 * como realizados o pendientes cuando ese dato no consta en el registro. */
export function conditionNotation(
  condition?: ToothCondition,
): ConditionNotation {
  switch (condition) {
    case "caries":
      return {
        tone: "blue",
        symbol: "caries",
        description: "Caries: marca azul",
      };
    case "obturado":
      return {
        tone: "red",
        symbol: "restoration",
        description: "Obturación: círculo rojo",
      };
    case "extraccion_indicada":
      return {
        tone: "blue",
        symbol: "extraction",
        description: "Extracción indicada: dos líneas paralelas azules",
      };
    case "ausente":
      return {
        tone: "blue",
        symbol: "missing",
        description: "Ausente: cruz azul",
      };
    case "sano":
      return {
        tone: "neutral",
        symbol: "healthy",
        description: "Pieza registrada como sana",
      };
    case undefined:
      return {
        tone: "neutral",
        symbol: "unrecorded",
        description: "Pieza sin registrar",
      };
    default:
      return {
        tone: "neutral",
        symbol: "label",
        description: "Consultar el estado y las notas del registro",
      };
  }
}

export interface ToothDiagramFace {
  surface: ToothSurface;
  points: string;
  cx: number;
  cy: number;
  condition: ToothCondition | undefined;
}

/** Una cara con otro hallazgo no localiza el estado general de la pieza. */
export function hasUnlocalizedFinding(
  condition: ToothCondition | undefined,
  surfaces: OdontogramEntry["surfaces"] = {},
): boolean {
  return (
    (condition === "caries" || condition === "obturado") &&
    !Object.values(surfaces).some((finding) => finding === condition)
  );
}

/** Esquema de cinco caras visto de frente al paciente. La cara mesial siempre
 * apunta a la línea media; la vestibular queda fuera de ambas arcadas.
 * Sólo dibuja hallazgos de caras expresamente registradas. */
export function toothDiagramFaces(
  tooth: number,
  surfaces: OdontogramEntry["surfaces"] = {},
): ToothDiagramFace[] {
  if (!isValidTooth(tooth)) throw new Error("INVALID_TOOTH");
  const upper = isUpperTooth(tooth);
  const quadrant = Math.floor(tooth / 10);
  const patientRight = [1, 4, 5, 8].includes(quadrant);
  const geometry: Omit<ToothDiagramFace, "condition">[] = [
    {
      surface: upper ? "vestibular" : "palatina_lingual",
      points: "10,10 90,10 70,30 30,30",
      cx: 50,
      cy: 20,
    },
    {
      surface: patientRight ? "mesial" : "distal",
      points: "90,10 90,90 70,70 70,30",
      cx: 80,
      cy: 50,
    },
    {
      surface: upper ? "palatina_lingual" : "vestibular",
      points: "90,90 10,90 30,70 70,70",
      cx: 50,
      cy: 80,
    },
    {
      surface: patientRight ? "distal" : "mesial",
      points: "10,90 10,10 30,30 30,70",
      cx: 20,
      cy: 50,
    },
    { surface: "oclusal", points: "30,30 70,30 70,70 30,70", cx: 50, cy: 50 },
  ];
  return geometry.map((face) => ({
    ...face,
    condition: surfaces[face.surface],
  }));
}
