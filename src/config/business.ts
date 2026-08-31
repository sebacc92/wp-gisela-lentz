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

/**
 * Datos que Gisela confirmó para comunicación pública. Se mantienen separados
 * de los valores iniciales del panel para que una instalación sin configurar
 * no publique datos por accidente.
 */
export const PUBLIC_BUSINESS_CONFIG = {
  displayName: "Gisela Lentz Odontología",
  phoneDisplay: "+54 9 2291 41-4102",
  phoneE164: "+5492291414102",
  whatsappNumber: "5492291414102",
  whatsappUrl:
    "https://wa.me/5492291414102?text=Hola%20Gisela%2C%20quisiera%20consultar%20por%20un%20turno.",
  streetAddress: "Calle 11 N° 1375, entre 26 y 28",
  locality: "Miramar",
  region: "Provincia de Buenos Aires",
  country: "AR",
} as const;

export const APP_DESCRIPTION =
  "Agenda, pacientes y conversaciones de WhatsApp de Gisela Lentz.";

export function getPageTitle(page?: string): string {
  return page ? `${page} · ${BUSINESS_CONFIG.name}` : BUSINESS_CONFIG.name;
}
