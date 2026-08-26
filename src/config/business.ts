export const BUSINESS_CONFIG = {
  name: "Gisela Lentz",
  subtitle: "Odontología",
  tagline: "Tu sonrisa, cuidada con calma.",
  phone: "",
  email: "",
  address: "",
  schedule: "",
  logoUrl: "",
  timezone: "America/Argentina/Buenos_Aires",
} as const;

export const APP_DESCRIPTION =
  "Agenda, pacientes y conversaciones de WhatsApp de Gisela Lentz.";

export function getPageTitle(page?: string): string {
  return page ? `${page} · ${BUSINESS_CONFIG.name}` : BUSINESS_CONFIG.name;
}
