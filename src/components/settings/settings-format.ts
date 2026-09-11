import { BUSINESS_CONFIG } from "~/config/business";

/** Formatos compartidos por las pestañas de Configuración. */

export const weekdays = [
  "Domingo",
  "Lunes",
  "Martes",
  "Miércoles",
  "Jueves",
  "Viernes",
  "Sábado",
];

/** `09:00:00` guardado en Postgres se muestra como `09:00`. */
export function cleanTime(value: string): string {
  return value.slice(0, 5);
}

export function formatSettingsDate(value: string): string {
  return new Intl.DateTimeFormat("es-AR", {
    dateStyle: "long",
    timeZone: "UTC",
  }).format(new Date(`${value}T12:00:00Z`));
}

export function formatLastCalendarSync(value: string): string {
  if (!value) return "Todavía no se sincronizó";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Todavía no se sincronizó";
  return new Intl.DateTimeFormat("es-AR", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: BUSINESS_CONFIG.timezone,
  }).format(date);
}
