import {
  normalizePhoneE164,
  phoneForAgendaTitle,
} from "../../shared/phone.ts";

export { normalizePhoneE164, phoneForAgendaTitle };

export function displayPhone(value: string): string {
  return normalizePhoneE164(value) ?? value.trim();
}
