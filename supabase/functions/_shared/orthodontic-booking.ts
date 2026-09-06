import { normalizeUserInput } from "./automation-flow.ts";

export type OrthodonticVisitType = "first_visit" | "in_treatment";

export const ORTHODONTIC_VISIT_PROMPT =
  "¿Es tu primera consulta de ortodoncia con Gisela o ya estás en tratamiento con ella? Si estás en tratamiento con Gisela, este turno no requiere seña.";

export const ORTHODONTIC_VISIT_OPTIONS = [
  { id: "ortho:first_visit", title: "Primera vez" },
  { id: "ortho:in_treatment", title: "En tratamiento" },
  { id: "ortho:back", title: "Cambiar servicio" },
];

export function orthodonticVisitType(
  value: unknown,
): OrthodonticVisitType | null {
  return value === "first_visit" || value === "in_treatment" ? value : null;
}

/** Only an explicit answer to the orthodontic intake establishes this choice. */
export function parseOrthodonticVisitReply(
  value: string,
): OrthodonticVisitType | null {
  if (value === "ortho:first_visit") return "first_visit";
  if (value === "ortho:in_treatment") return "in_treatment";
  if (/[¿?]/.test(value)) return null;
  const input = normalizeUserInput(value);
  if (
    /^(?:(?:es )?mi )?(?:primera vez|1ra vez|1era vez|primera consulta)(?: con gisela)?$/.test(
      input,
    )
  )
    return "first_visit";
  if (
    /^(?:(?:ya |sigo |estoy |ya estoy |sigo estando ))?en (?:tratamiento|tto)(?: con (?:la dra |la doctora )?gisela)?$/.test(
      input,
    )
  )
    return "in_treatment";
  return null;
}

export function bookingConfirmationCopy(args: {
  serviceName: string;
  date: string;
  time: string;
  depositEnabled: boolean;
  visitType: OrthodonticVisitType | null;
}): { message: string; confirmLabel: string; depositRequired: boolean } {
  const depositRequired =
    args.depositEnabled && args.visitType !== "in_treatment";
  const visit =
    args.visitType === "in_treatment"
      ? "\nEn tratamiento con Gisela · Sin seña"
      : args.visitType === "first_visit"
        ? "\nPrimera consulta de ortodoncia"
        : "";
  const confirmLabel = depositRequired ? "Pre-reservar" : "Reservar turno";
  const message =
    `Revisá los datos antes de reservar:\n\n${args.serviceName}${visit}\n` +
    `📅 ${args.date}\n🕐 ${args.time}\n\n` +
    "⚠️ Este horario todavía no está reservado.\n" +
    (depositRequired
      ? "Tocá “Pre-reservar” para guardarlo mientras enviás la seña."
      : "Este turno no requiere seña. Tocá “Reservar turno” para continuar.");
  return { message, confirmLabel, depositRequired };
}
