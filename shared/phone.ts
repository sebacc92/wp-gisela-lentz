/**
 * Normaliza un teléfono para compararlo y guardarlo como E.164.
 * No intenta adivinar país: si falta el prefijo internacional usa Argentina.
 * Compartido por el frontend y las Functions, sin dependencias de sus runtimes.
 */
export function normalizePhoneE164(value: string): string | null {
  const trimmed = value.trim();
  const explicitInternational =
    trimmed.startsWith("+") || trimmed.startsWith("00");
  let digits = trimmed.replace(/\D/g, "");
  if (!digits) return null;

  if (digits.startsWith("00")) digits = digits.slice(2);
  if (explicitInternational && !digits.startsWith("54")) {
    return /^[1-9][0-9]{7,14}$/.test(digits) ? `+${digits}` : null;
  }

  let national = digits.startsWith("54") ? digits.slice(2) : digits;
  national = national.replace(/^0+/, "");

  // Los celulares argentinos escritos como 011 15… omiten el 9
  // internacional e incluyen el prefijo local 15. Se aceptan áreas de 2 a 4
  // dígitos, que cubren los formatos administrativos habituales.
  if (national.length === 12) {
    for (let areaLength = 2; areaLength <= 4; areaLength += 1) {
      if (national.slice(areaLength, areaLength + 2) === "15") {
        national =
          national.slice(0, areaLength) + national.slice(areaLength + 2);
        break;
      }
    }
  }

  if (national.length === 10) national = `9${national}`;
  digits = `54${national}`;

  if (!/^[1-9][0-9]{7,14}$/.test(digits)) {
    return null;
  }
  return `+${digits}`;
}

/**
 * Teléfono tal como lo escribe Gisela en su agenda: los 10 dígitos de área y
 * número, sin `+54` ni el 9 de celular. `2262338010`, no `+5492262338010`.
 *
 * Es la inversa exacta de `normalizePhoneE164` para celulares argentinos:
 * esos 10 dígitos vuelven a leerse como el mismo celular. Un número de otro
 * país se devuelve en E.164, porque sin el prefijo no se podría marcar.
 */
export function phoneForAgendaTitle(e164: string): string | null {
  const trimmed = e164.trim();
  if (!/^\+[1-9][0-9]{7,14}$/.test(trimmed)) return null;
  const argentine = /^\+549?(\d{10})$/.exec(trimmed);
  return argentine ? argentine[1] : trimmed;
}
