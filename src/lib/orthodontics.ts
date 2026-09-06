import type { OrthodonticVisitType } from "./inbox-types";

export const ORTHODONTIC_VISIT_LABELS: Record<OrthodonticVisitType, string> = {
  first_visit: "Primera vez",
  in_treatment: "En tratamiento con Gisela",
};

export function orthodonticVisitType(
  value: unknown,
): OrthodonticVisitType | null {
  return value === "first_visit" || value === "in_treatment" ? value : null;
}
