import type { AppointmentStatus } from "./booking";
import type { DepositStatus } from "./inbox-types";

/**
 * Métricas del panel de inicio. Son funciones puras: reciben lo que ya se
 * cargó y no consultan Supabase, así el cálculo se puede probar sin base y la
 * pantalla no depende de que una consulta extra haya salido bien.
 *
 * Ninguna de estas métricas decide nada operativo. Cuando falta información
 * devuelven `null` en lugar de un cero: un porcentaje de asistencia en 0 %
 * y "todavía no hay datos" significan cosas muy distintas para Gisela.
 */

export interface DashboardMetricsAppointment {
  startsAt: string;
  status: AppointmentStatus;
  depositStatus: DepositStatus;
  depositExpectedAmountArs: number | null;
}

export interface AttendanceMetric {
  completed: number;
  noShow: number;
  /** Porcentaje 0-100 redondeado, o `null` si todavía no hay turnos cerrados. */
  rate: number | null;
}

export interface DepositRevenueMetric {
  /** Señas informadas que todavía no entraron. */
  pendingArs: number;
  /** Señas ya confirmadas de turnos que aún no ocurrieron. */
  confirmedArs: number;
  totalArs: number;
  /** Turnos futuros cuyo monto de seña no quedó registrado. */
  unknownAmountCount: number;
}

export interface ResponseDistributionMetric {
  bot: number;
  human: number;
  total: number;
  /** Porcentaje 0-100 de respuestas automáticas, o `null` sin mensajes. */
  botShare: number | null;
}

/** Ventana de la métrica de asistencia y del reparto de respuestas. */
export const ATTENDANCE_WINDOW_DAYS = 7;

function parseTime(value: string): number | null {
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

/**
 * Asistencia de los últimos siete días. Sólo cuenta turnos ya cerrados como
 * atendidos o ausentes: un turno cancelado no es una ausencia, y uno todavía
 * agendado no dice nada sobre asistencia.
 */
export function weeklyAttendance(
  appointments: readonly DashboardMetricsAppointment[],
  now: number = Date.now(),
  windowDays: number = ATTENDANCE_WINDOW_DAYS,
): AttendanceMetric {
  const from = now - windowDays * 24 * 60 * 60 * 1_000;
  let completed = 0;
  let noShow = 0;

  for (const appointment of appointments) {
    const startsAt = parseTime(appointment.startsAt);
    if (startsAt === null || startsAt < from || startsAt > now) continue;
    if (appointment.status === "completed") completed += 1;
    else if (appointment.status === "no_show") noShow += 1;
  }

  const closed = completed + noShow;
  return {
    completed,
    noShow,
    rate: closed === 0 ? null : Math.round((completed / closed) * 100),
  };
}

/**
 * Seña proyectada de los turnos que todavía no ocurrieron. Separa lo que falta
 * cobrar de lo ya confirmado porque son dos decisiones distintas: una se
 * reclama y la otra no. Un turno cancelado o con la pre-reserva vencida no
 * proyecta ingreso.
 */
export function projectedDepositRevenue(
  appointments: readonly DashboardMetricsAppointment[],
  now: number = Date.now(),
): DepositRevenueMetric {
  let pendingArs = 0;
  let confirmedArs = 0;
  let unknownAmountCount = 0;

  for (const appointment of appointments) {
    const startsAt = parseTime(appointment.startsAt);
    if (startsAt === null || startsAt < now) continue;
    if (appointment.status === "cancelled") continue;

    const { depositStatus } = appointment;
    if (
      depositStatus !== "pending" &&
      depositStatus !== "proof_received" &&
      depositStatus !== "confirmed"
    ) {
      continue;
    }

    const amount = appointment.depositExpectedAmountArs;
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
      unknownAmountCount += 1;
      continue;
    }

    if (depositStatus === "confirmed") confirmedArs += amount;
    else pendingArs += amount;
  }

  return {
    pendingArs,
    confirmedArs,
    totalArs: pendingArs + confirmedArs,
    unknownAmountCount,
  };
}

/**
 * Reparto entre respuestas automáticas y escritas por una persona. `sent_by`
 * queda en null cuando el mensaje lo generó la automatización y guarda el
 * usuario cuando alguien contestó desde la bandeja, así que el reparto se
 * calcula sobre esa distinción y no sobre el contenido del mensaje.
 */
export function responseDistribution(input: {
  bot: number;
  human: number;
}): ResponseDistributionMetric {
  const bot = Math.max(0, Math.trunc(input.bot));
  const human = Math.max(0, Math.trunc(input.human));
  const total = bot + human;
  return {
    bot,
    human,
    total,
    botShare: total === 0 ? null : Math.round((bot / total) * 100),
  };
}

export function formatArs(value: number): string {
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    maximumFractionDigits: 0,
  }).format(value);
}
