/**
 * Detector de pedidos que no pueden viajar por WhatsApp.
 *
 * Marca texto que pide datos sensibles —identidad, datos bancarios o
 * información clínica— antes de guardarlo como mensaje automático o plantilla.
 * Es una ayuda para quien escribe, no un control de seguridad: avisa sobre lo
 * que se está por escribir y nunca decide sola qué se envía.
 *
 * Trabaja sobre el texto sin acentos y en minúsculas para que "diagnóstico" y
 * "diagnostico" pesen igual.
 */

export function normalizedPolicyText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("es-AR");
}

const RESTRICTED_PATTERN =
  /\b(dni|documento de identidad|pasaporte|cuil|cuit|tarjeta|cuenta bancaria|cbu|numero de cuenta|historia clinica|diagnostico|receta|medicacion|dosis|sintomas?)\b/;

export function containsRestrictedAutomationRequest(value: string): boolean {
  return RESTRICTED_PATTERN.test(normalizedPolicyText(value));
}

/** El término concreto que disparó el aviso, para poder señalarlo. */
export function restrictedAutomationTerm(value: string): string | null {
  return RESTRICTED_PATTERN.exec(normalizedPolicyText(value))?.[0] ?? null;
}

export const RESTRICTED_AUTOMATION_NOTICE =
  "Ese texto pide datos personales, bancarios o clínicos. WhatsApp no es el canal para eso: reescribilo sin pedirlos.";
