import { BUSINESS_CONFIG } from "../config/business.ts";

/**
 * Datos que una respuesta rápida puede completar sola.
 *
 * Sigue la convención que ya usan las plantillas de seña: `{snake_case}`, y lo
 * que no se puede resolver **queda a la vista** en lugar de desaparecer. Un
 * "Hola {patient_name}" enviado así se nota; un "Hola " vacío, no. Como quien
 * escribe revisa el mensaje antes de mandarlo, dejar el hueco visible es la
 * falla segura.
 */

export interface QuickReplyContext {
  patientName?: string | null;
  /** ISO del próximo turno; de ahí salen fecha y hora. */
  appointmentStartsAt?: string | null;
  depositAmountArs?: number | null;
  depositAlias?: string | null;
  depositHolder?: string | null;
}

export interface QuickReplyPlaceholder {
  key: string;
  label: string;
  hint: string;
}

export const QUICK_REPLY_PLACEHOLDERS: readonly QuickReplyPlaceholder[] = [
  {
    key: "patient_name",
    label: "Nombre del paciente",
    hint: "Sólo el primer nombre, para saludar.",
  },
  {
    key: "appointment_date",
    label: "Fecha del próximo turno",
    hint: "Por ejemplo, «jueves 11 de septiembre».",
  },
  {
    key: "appointment_time",
    label: "Hora del próximo turno",
    hint: "Por ejemplo, «10:30».",
  },
  {
    key: "deposit_amount",
    label: "Importe de la seña",
    hint: "El monto configurado en Reservas.",
  },
  { key: "deposit_alias", label: "Alias para transferir", hint: "" },
  { key: "deposit_holder", label: "Titular de la cuenta", hint: "" },
];

const PLACEHOLDER_PATTERN = /\{([a-z][a-z0-9_]*)\}/g;

function firstName(value: string): string {
  return value.trim().split(/\s+/)[0] ?? "";
}

function formatAmountArs(amount: number): string {
  return `$${new Intl.NumberFormat("es-AR", {
    maximumFractionDigits: 0,
  }).format(amount)}`;
}

function formatPart(
  startsAt: string,
  options: Intl.DateTimeFormatOptions,
): string {
  return new Intl.DateTimeFormat("es-AR", {
    ...options,
    timeZone: BUSINESS_CONFIG.timezone,
  }).format(new Date(startsAt));
}

/** Sólo los valores que se pudieron resolver. Lo ausente no entra. */
export function quickReplyValues(
  context: QuickReplyContext,
): Record<string, string> {
  const values: Record<string, string> = {};

  const name = context.patientName?.trim();
  if (name) values.patient_name = firstName(name);

  const startsAt = context.appointmentStartsAt;
  if (startsAt && !Number.isNaN(Date.parse(startsAt))) {
    values.appointment_date = formatPart(startsAt, {
      weekday: "long",
      day: "numeric",
      month: "long",
    });
    values.appointment_time = formatPart(startsAt, {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
  }

  const amount = context.depositAmountArs;
  if (typeof amount === "number" && Number.isFinite(amount) && amount > 0) {
    values.deposit_amount = formatAmountArs(amount);
  }

  const alias = context.depositAlias?.trim();
  if (alias) values.deposit_alias = alias;

  const holder = context.depositHolder?.trim();
  if (holder) values.deposit_holder = holder;

  return values;
}

export interface InterpolatedQuickReply {
  text: string;
  /** Placeholders que quedaron sin completar, en orden de aparición. */
  unresolved: string[];
}

export function interpolateQuickReply(
  body: string,
  context: QuickReplyContext,
): InterpolatedQuickReply {
  const values = quickReplyValues(context);
  const unresolved: string[] = [];

  const text = body.replace(
    PLACEHOLDER_PATTERN,
    (placeholder, key: string): string => {
      if (Object.prototype.hasOwnProperty.call(values, key)) return values[key];
      if (!unresolved.includes(key)) unresolved.push(key);
      return placeholder;
    },
  );

  return { text, unresolved };
}

export function describePlaceholder(key: string): string {
  return (
    QUICK_REPLY_PLACEHOLDERS.find((item) => item.key === key)?.label ?? key
  );
}
