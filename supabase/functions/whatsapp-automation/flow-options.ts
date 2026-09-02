import { normalizeUserInput } from "../_shared/automation-flow.ts";

export const SECRETARY_REPLY_ID = "flow:secretary";
export const SECRETARY_HANDOFF_MESSAGE =
  "Claro 😊 Voy a derivar tu consulta con la secretaria para que pueda ayudarte por este chat.";

interface MenuOption {
  id: string;
  title: string;
  description?: string;
}

export function withSecretaryMenuOption(options: MenuOption[]): MenuOption[] {
  return [
    ...options.filter((option) => option.id !== "flow:human"),
    { id: SECRETARY_REPLY_ID, title: "Hablar con la secretaria" },
  ];
}

export function isSecretaryRequest(value: string): boolean {
  if (value === SECRETARY_REPLY_ID) return true;
  const input = normalizeUserInput(value);
  return /^(?:(?:quiero|quisiera|necesito) )?(?:(?:hablar|comunicarme|consultar) (?:con )?(?:la )?)?secretaria$/.test(
    input,
  );
}

export interface NamedServiceOption {
  id: string;
  name: string;
}

/**
 * Resuelve el nombre contra las opciones activas de la base. Acepta acentos y
 * mayúsculas, y sólo quita envoltorios inequívocos de pedido de turno. Si dos
 * filas coincidieran, falla cerrado.
 */
export function resolveTypedServiceOption<T extends NamedServiceOption>(
  value: string,
  options: T[],
): T | null {
  const input = normalizeUserInput(value);
  if (!input) return null;
  const wrapped =
    /^(?:(?:hola|buen dia|buenas) )?(?:(?:quiero|quisiera|queria|necesito|busco) )?(?:(?:sacar|pedir|reservar|agendar) )?(?:un )?turno(?: (?:de|para))? (.+)$/.exec(
      input,
    );
  const requestedName = wrapped?.[1]?.trim() || input;
  const matches = options.filter(
    (option) => normalizeUserInput(option.name) === requestedName,
  );
  return matches.length === 1 ? matches[0] : null;
}
