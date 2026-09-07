import { normalizePhoneE164 } from "../../shared/phone.ts";

export { normalizePhoneE164 };

export function displayPhone(value: string): string {
  return normalizePhoneE164(value) ?? value.trim();
}
