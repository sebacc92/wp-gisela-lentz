import { normalizeUserInput } from "./automation-flow.ts";
import { extractOwnerPatientQuery } from "./owner-patient-query.ts";
import {
  type OwnerAgendaDay,
  ownerLocalDate,
  OWNER_TIMEZONE,
  parseOwnerAgendaDay,
} from "./owner-agenda-period.ts";

export { OWNER_TIMEZONE } from "./owner-agenda-period.ts";

/**
 * Números autorizados a recibir información privada por WhatsApp: la agenda con
 * nombres de pacientes y los datos administrativos de un paciente.
 *
 * Vive en un secreto de servidor y no en la base a propósito. Habilita el
 * acceso a todos los datos de pacientes, así que no debe poder agregarse desde
 * una sesión de la aplicación: si una cuenta ADMIN quedara comprometida,
 * sumar un número propio sería suficiente para vaciar la agenda por WhatsApp.
 */
const E164_PATTERN = /^\+[1-9]\d{7,14}$/;

/** Tope de teléfonos autorizados. La lista es nominal y corta —la profesional
 * y, mientras dure un trabajo técnico, quien la asiste—; el límite evita que un
 * secreto pegado de más convierta la agenda en un canal abierto. */
const MAX_OWNER_NUMBERS = 3;

export function parseOwnerNumbers(raw: string | undefined): Set<string> {
  const numbers = new Set<string>();
  for (const candidate of (raw ?? "").split(",")) {
    const value = candidate.trim();
    if (E164_PATTERN.test(value)) numbers.add(value);
  }
  return numbers;
}

/** Falla cerrado: sin allowlist, con un teléfono ausente o con un formato que
 * no es E.164 exacto, nadie es dueño del número. */
export function isOwnerNumber(
  phoneE164: string | null | undefined,
  allowlist: Set<string>,
): boolean {
  if (!allowlist.size) return false;
  if (typeof phoneE164 !== "string") return false;
  const value = phoneE164.trim();
  if (!E164_PATTERN.test(value)) return false;
  return allowlist.has(value);
}

export type OwnerRequest =
  | { kind: "agenda"; day: OwnerAgendaDay }
  | { kind: "patient"; query: string };

const AGENDA_WORDS = /\b(turno|turnos|agenda|agendados|pacientes|citas)\b/;

/**
 * Reconoce de forma determinista qué está pidiendo. No usa IA: la respuesta
 * contiene datos de pacientes y no puede depender de que un modelo interprete
 * bien una frase.
 */
export function detectOwnerRequest(
  body: string,
  now = new Date(),
): OwnerRequest | null {
  const phrase = normalizeUserInput(body);
  if (!phrase) return null;

  const patient = extractOwnerPatientQuery(body);
  if (patient) return { kind: "patient", query: patient };

  if (AGENDA_WORDS.test(phrase)) {
    const day = parseOwnerAgendaDay(body, now);
    return day === null ? null : { kind: "agenda", day };
  }

  return null;
}

export const OWNER_HELP_MESSAGE =
  'Podés consultar la agenda y los datos administrativos de pacientes. Probá con "próximos turnos", "turnos del jueves", "turnos del 10/9" o "datos de Ana Pérez". Si pedís otro período, indicame la fecha para buscarlo.';

function runtimeEnvironment(name: string): string | undefined {
  if (typeof Deno !== "undefined") return Deno.env.get(name);
  const nodeProcess = (
    globalThis as typeof globalThis & {
      process?: { env?: Record<string, string | undefined> };
    }
  ).process;
  return nodeProcess?.env?.[name];
}

export function ownerNumbersFromEnvironment(): Set<string> {
  const raw = runtimeEnvironment("WHATSAPP_OWNER_NUMBERS");
  const written = new Set(
    (raw ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  );
  const configured = parseOwnerNumbers(raw);
  // Falla cerrado ante una lista que no se entiende entera: si alguna entrada
  // no es E.164 exacto no se puede saber a quién se quiso autorizar, y una
  // lista más larga que la prevista tampoco se acepta a medias.
  if (!configured.size || configured.size !== written.size) {
    return new Set<string>();
  }
  return configured.size <= MAX_OWNER_NUMBERS ? configured : new Set<string>();
}

/** Una identidad proviene del webhook firmado, nunca de un teléfono editable. */
export function verifiedOwnerPhone(
  metadata: Record<string, unknown> | null | undefined,
  allowlist = ownerNumbersFromEnvironment(),
): string | null {
  const phone = metadata?.verified_sender_phone_e164;
  return metadata?.sender_identity_source === "signed_meta_webhook" &&
    typeof phone === "string" &&
    isOwnerNumber(phone, allowlist)
    ? phone
    : null;
}

export function ownerAgendaRange(
  day: OwnerAgendaDay,
  now = new Date(),
): { from: string; until: string | null; localDate: string } {
  const date = ownerLocalDate(now);
  if (day === "upcoming")
    return { from: now.toISOString(), until: null, localDate: date };
  // Argentina usa UTC-03. Límites explícitos evitan incluir turnos de las
  // 21–24 del día anterior cuando el servidor trabaja en UTC.
  const from = new Date(
    `${typeof day === "object" ? day.date : date}T00:00:00-03:00`,
  );
  if (day === "tomorrow") from.setUTCDate(from.getUTCDate() + 1);
  const until = new Date(from);
  until.setUTCDate(
    until.getUTCDate() +
      (day === "week" ? 7 : typeof day === "object" ? (day.days ?? 1) : 1),
  );
  return {
    from: from.toISOString(),
    until: until.toISOString(),
    localDate: date,
  };
}

export function ownerSummarySchedule(now = new Date()): {
  due: boolean;
  date: string;
  scheduledAt: string;
} {
  const { localDate } = ownerAgendaRange("today", now);
  const scheduledAt = new Date(`${localDate}T21:00:00-03:00`);
  const elapsed = now.getTime() - scheduledAt.getTime();
  return {
    due: elapsed >= 0 && elapsed < 15 * 60 * 1000,
    date: localDate,
    scheduledAt: scheduledAt.toISOString(),
  };
}

function plainSummaryValue(value: string, limit = 120): string {
  return value
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, limit);
}

export interface OwnerAgendaAppointment {
  startsAt: string;
  patientName: string;
  patientPhone: string | null;
  coverage: string | null;
  service: string | null;
  depositStatus: string | null;
}

const DAY_TITLES = {
  today: "Turnos de hoy",
  tomorrow: "Turnos de mañana",
  week: "Turnos de los próximos 7 días",
  upcoming: "Próximos turnos",
};

function timeIn(value: string, timezone: string): string {
  return new Intl.DateTimeFormat("es-AR", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(value));
}

function dayIn(value: string, timezone: string): string {
  return new Intl.DateTimeFormat("es-AR", {
    timeZone: timezone,
    weekday: "long",
    day: "numeric",
    month: "numeric",
  }).format(new Date(value));
}

function depositSuffix(status: string | null): string {
  if (status === "pending") return " — esperando seña";
  if (status === "proof_received") return " — comprobante a revisar";
  return "";
}

export function formatOwnerAgenda(args: {
  appointments: OwnerAgendaAppointment[];
  day: OwnerAgendaDay;
  timezone: string;
  now?: Date;
  hasMore?: boolean;
  blocks?: Array<{ startsAt: string; endsAt: string; allDay: boolean }>;
  calendarNeedsReview?: boolean;
}): string {
  const range = ownerAgendaRange(args.day, args.now);
  const title =
    typeof args.day === "object"
      ? `${args.day.days === 7 ? "Turnos desde el" : "Turnos del"} ${dayIn(range.from, args.timezone)}`
      : `${DAY_TITLES[args.day]}${args.day === "today" || args.day === "tomorrow" ? ` (${dayIn(range.from, args.timezone)})` : ""}`;
  const groupByDate =
    args.day === "week" ||
    args.day === "upcoming" ||
    (typeof args.day === "object" && args.day.days === 7);
  const lines: string[] = [
    args.appointments.length
      ? `${title}:`
      : `${title}: sin turnos cargados en el sistema.`,
  ];
  if (args.appointments.length) lines.push("");
  let lastDay = "";
  let shown = 0;
  for (const appointment of args.appointments) {
    if (lines.join("\n").length > 3400) break;
    shown += 1;
    if (groupByDate) {
      const day = dayIn(appointment.startsAt, args.timezone);
      if (day !== lastDay) {
        if (lastDay) lines.push("");
        lines.push(day);
        lastDay = day;
      }
    }
    const parts = [
      timeIn(appointment.startsAt, args.timezone),
      plainSummaryValue(appointment.patientName),
    ];
    if (appointment.coverage) {
      parts.push(appointment.coverage === "ioma" ? "IOMA" : "Particular");
    }
    // El resumen no exporta motivos clínicos ni tratamientos por WhatsApp.
    lines.push(
      `${parts.join(" · ")}${depositSuffix(appointment.depositStatus)}`,
    );
  }
  if (shown > 0) lines.push("");
  if (shown < args.appointments.length) {
    lines.push(
      `+ ${args.appointments.length - shown} turnos más. Consultá la agenda completa en /app.`,
    );
  }
  if (args.hasMore)
    lines.push(
      "Hay más turnos. Pedime un día específico o consultá la agenda completa en /app.",
    );
  if (args.appointments.length > 0 && !args.hasMore)
    lines.push(
      args.appointments.length === 1
        ? "1 turno."
        : `${args.appointments.length} turnos.`,
    );
  if (args.blocks?.length) {
    lines.push("", "Horarios ocupados en Google Calendar:");
    let shownBlocks = 0;
    for (const block of args.blocks) {
      if (shownBlocks >= 3 || lines.join("\n").length > 3700) break;
      const day = groupByDate
        ? `${dayIn(block.startsAt, args.timezone)} · `
        : "";
      lines.push(
        `${day}${block.allDay ? "Todo el día" : `${timeIn(block.startsAt, args.timezone)}–${timeIn(block.endsAt, args.timezone)}`} · Ocupado`,
      );
      shownBlocks += 1;
    }
    if (shownBlocks < args.blocks.length)
      lines.push(`+ ${args.blocks.length - shownBlocks} horarios más en /app.`);
  }
  if (args.calendarNeedsReview)
    lines.push(
      "",
      "Google Calendar necesita una revisión reciente. Verificá la agenda en /app.",
    );
  return lines.join("\n");
}

export interface OwnerPatientSummary {
  name: string;
  phone: string | null;
  coverage: string | null;
  notes: string | null;
  nextAppointment: OwnerAgendaAppointment | null;
}

export function formatOwnerPatient(args: {
  matches: OwnerPatientSummary[];
  query: string;
  timezone: string;
}): string {
  if (!args.matches.length) {
    return `No encontré ningún paciente que coincida con "${args.query}".`;
  }
  if (args.matches.length > 1) {
    const names = args.matches.slice(0, 8).map((match) => `· ${match.name}`);
    return [
      `Encontré ${args.matches.length} pacientes con "${args.query}":`,
      "",
      ...names,
      "",
      'Escribime "datos de" seguido del nombre completo del paciente que necesitás.',
    ].join("\n");
  }

  const patient = args.matches[0];
  const lines = [patient.name];
  if (patient.phone) lines.push(`Teléfono: ${patient.phone}`);
  if (patient.coverage) {
    lines.push(
      `Cobertura: ${patient.coverage === "ioma" ? "IOMA" : "Particular"}`,
    );
  }
  if (patient.nextAppointment) {
    lines.push(
      `Próximo turno: ${dayIn(patient.nextAppointment.startsAt, args.timezone)} ${timeIn(patient.nextAppointment.startsAt, args.timezone)}`,
    );
  } else {
    lines.push("Próximo turno: no tiene");
  }
  // Las notas libres pueden contener datos clínicos; se consultan en /app.
  lines.push("Ficha completa y notas: consultá el sistema interno.");
  return lines.join("\n");
}
