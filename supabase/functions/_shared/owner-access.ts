import { normalizeUserInput } from "./automation-flow.ts";

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
  | { kind: "agenda"; day: "today" | "tomorrow" | "week" }
  | { kind: "patient"; query: string };

const AGENDA_WORDS =
  /\b(turno|turnos|agenda|agendados|pacientes|citas|tengo|tenes|tenés)\b/;

/**
 * Reconoce de forma determinista qué está pidiendo. No usa IA: la respuesta
 * contiene datos de pacientes y no puede depender de que un modelo interprete
 * bien una frase.
 */
export function detectOwnerRequest(body: string): OwnerRequest | null {
  const phrase = normalizeUserInput(body);
  if (!phrase) return null;

  const patient = phrase.match(
    /^(?:datos|ficha|info|informacion|telefono|buscar|paciente)\s+(?:de\s+)?(?:la\s+|el\s+)?(?:paciente\s+)?(.{2,60})$/,
  );

  if (AGENDA_WORDS.test(phrase)) {
    if (/\b(manana|el dia de manana)\b/.test(phrase)) {
      return { kind: "agenda", day: "tomorrow" };
    }
    if (/\b(semana|la semana|esta semana)\b/.test(phrase)) {
      return { kind: "agenda", day: "week" };
    }
    if (/\b(hoy|el dia de hoy)\b/.test(phrase)) {
      return { kind: "agenda", day: "today" };
    }
    // "Me das los turnos" sin fecha se responde con el día en curso.
    if (!patient) return { kind: "agenda", day: "today" };
  }

  if (patient?.[1]) {
    const query = patient[1].trim();
    if (query.length >= 2) return { kind: "patient", query };
  }
  return null;
}

export const OWNER_HELP_MESSAGE =
  'Puedo pasarte los turnos de hoy, los de mañana o los de la semana, y los datos de un paciente. Escribime por ejemplo "turnos de mañana" o "datos de Ana Pérez".';

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
  const configured = parseOwnerNumbers(
    runtimeEnvironment("WHATSAPP_OWNER_NUMBERS"),
  );
  // Este consultorio pertenece a una sola profesional. Una lista ambigua no
  // puede ampliar silenciosamente el acceso a toda la agenda.
  return configured.size === 1 ? configured : new Set<string>();
}

export const OWNER_TIMEZONE = "America/Argentina/Buenos_Aires";

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
  day: "today" | "tomorrow" | "week",
  now = new Date(),
): { from: string; until: string; localDate: string } {
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: OWNER_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  // Argentina usa UTC-03. Límites explícitos evitan incluir turnos de las
  // 21–24 del día anterior cuando el servidor trabaja en UTC.
  const from = new Date(`${date}T00:00:00-03:00`);
  if (day === "tomorrow") from.setUTCDate(from.getUTCDate() + 1);
  const until = new Date(from);
  until.setUTCDate(until.getUTCDate() + (day === "week" ? 7 : 1));
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

const DAY_TITLES: Record<"today" | "tomorrow" | "week", string> = {
  today: "Turnos de hoy",
  tomorrow: "Turnos de mañana",
  week: "Turnos de los próximos 7 días",
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
  day: "today" | "tomorrow" | "week";
  timezone: string;
  blocks?: Array<{ startsAt: string; endsAt: string; allDay: boolean }>;
  calendarNeedsReview?: boolean;
}): string {
  const title = DAY_TITLES[args.day];
  const lines: string[] = [
    args.appointments.length
      ? `${title}:`
      : `${title}: sin turnos cargados en el sistema.`,
    "",
  ];
  let lastDay = "";
  let shown = 0;
  for (const appointment of args.appointments) {
    if (lines.join("\n").length > 3400) break;
    shown += 1;
    if (args.day === "week") {
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
  lines.push("");
  if (shown < args.appointments.length) {
    lines.push(
      `+ ${args.appointments.length - shown} turnos más. Consultá la agenda completa en /app.`,
    );
  }
  lines.push(
    args.appointments.length === 1
      ? "1 turno."
      : `${args.appointments.length} turnos.`,
  );
  if (args.blocks?.length) {
    lines.push("", "Horarios ocupados en Google Calendar:");
    let shownBlocks = 0;
    for (const block of args.blocks) {
      if (lines.join("\n").length > 3700) break;
      const day =
        args.day === "week" ? `${dayIn(block.startsAt, args.timezone)} · ` : "";
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
      "Escribime el nombre completo del que necesitás.",
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
