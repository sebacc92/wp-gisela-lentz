import {
  $,
  component$,
  useContext,
  useSignal,
  useStore,
  useVisibleTask$,
} from "@qwik.dev/core";
import type { DocumentHead } from "@qwik.dev/router";
import { Link } from "@qwik.dev/router";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AppNavigation } from "~/components/app/AppNavigation";
import { APP_USER_CONTEXT } from "~/components/app/AppUserContext";
import "./dashboard.css";
import { BotAutomationControl } from "~/components/app/BotAutomationControl";
import { GoogleCalendarStatusBlock } from "~/components/app/GoogleCalendarStatusBlock";
import { IntegrationHealthBanner } from "~/components/app/IntegrationHealthBanner";
import { QuickActionsFab } from "~/components/app/QuickActionsFab";
import { Icon } from "~/components/ui/Icon";
import { APP_DESCRIPTION, getPageTitle } from "~/config/business";
import {
  businessDateInput,
  formatBusinessDate,
  getBusinessDayRange,
} from "~/lib/date-time";
import {
  appointmentDisplayStatus,
  appointmentStatusTone,
  coverageAndDuration,
  effectiveDepositStatus,
  type AppointmentStatus,
} from "~/lib/booking";
import {
  ATTENDANCE_WINDOW_DAYS,
  formatArs,
  projectedDepositRevenue,
  responseDistribution,
  weeklyAttendance,
} from "~/lib/dashboard-metrics";
import type { DepositStatus, PatientCoverage } from "~/lib/inbox-types";
import { getSupabaseClient } from "~/lib/supabase/client";
import { watchRealtimeTables } from "~/lib/supabase/realtime";

interface RelatedName {
  name: string;
}

interface AppointmentRow {
  id: string;
  starts_at: string;
  status: AppointmentStatus;
  coverage: PatientCoverage | null;
  duration_minutes: number;
  deposit_status: DepositStatus;
  hold_expires_at: string | null;
  deposit_proof_message_id: string | null;
  deposit_expected_amount_ars?: number | null;
  contact_id: string;
  contacts: RelatedName | RelatedName[] | null;
  patient?: RelatedName | RelatedName[] | null;
  services?: RelatedName | RelatedName[] | null;
}

interface DashboardAppointment {
  id: string;
  startsAt: string;
  status: AppointmentStatus;
  patientName: string;
  serviceName: string;
  coverage: PatientCoverage | null;
  durationMinutes: number;
  depositStatus: DepositStatus;
  depositProofMessageId: string | null;
  depositExpectedAmountArs: number | null;
  contactId: string;
}

const baseAppointmentSelect =
  "id,contact_id,starts_at,status,coverage,duration_minutes,deposit_status,hold_expires_at,deposit_proof_message_id,contacts!appointments_contact_id_fkey(name),patient:contacts!appointments_patient_contact_id_fkey(name)";

function singleRelation<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

function mapAppointments(rows: AppointmentRow[]): DashboardAppointment[] {
  return rows.map((row) => {
    const depositStatus = effectiveDepositStatus(
      row.status,
      row.deposit_status,
      row.hold_expires_at,
    );
    return {
      id: row.id,
      startsAt: row.starts_at,
      status: row.status,
      patientName:
        singleRelation(row.patient)?.name ??
        singleRelation(row.contacts)?.name ??
        "Paciente",
      serviceName:
        singleRelation(row.services)?.name ?? "Sin servicio asignado",
      coverage: row.coverage,
      durationMinutes: row.duration_minutes,
      depositStatus,
      depositProofMessageId: row.deposit_proof_message_id,
      depositExpectedAmountArs:
        typeof row.deposit_expected_amount_ars === "number"
          ? row.deposit_expected_amount_ars
          : null,
      contactId: row.contact_id,
    };
  });
}

async function loadDashboardAppointments(
  client: SupabaseClient,
  fromIso: string,
): Promise<DashboardAppointment[]> {
  const withServices = await client
    .from("appointments")
    .select(
      `${baseAppointmentSelect},deposit_expected_amount_ars,services(name)`,
    )
    .gte("starts_at", fromIso)
    .order("starts_at");

  if (!withServices.error) {
    return mapAppointments(
      (withServices.data ?? []) as unknown as AppointmentRow[],
    );
  }

  // `services` and the deposit snapshot are added by later migrations. Until
  // they are applied the dashboard stays operational with the original
  // appointment schema; the deposit metric simply reports an unknown amount.
  const existingSchema = await client
    .from("appointments")
    .select(baseAppointmentSelect)
    .gte("starts_at", fromIso)
    .order("starts_at");

  if (existingSchema.error) throw existingSchema.error;
  return mapAppointments(
    (existingSchema.data ?? []) as unknown as AppointmentRow[],
  );
}

function capitalize(value: string): string {
  return value
    ? `${value.charAt(0).toLocaleUpperCase("es-AR")}${value.slice(1)}`
    : value;
}

function agendaHref(options: {
  date: string;
  appointmentId?: string;
  status?: AppointmentStatus;
}): string {
  const params = new URLSearchParams({ date: options.date });
  if (options.appointmentId) {
    params.set("appointment", options.appointmentId);
  }
  if (options.status) params.set("status", options.status);
  return `/app/appointments?${params.toString()}`;
}

export default component$(() => {
  const appUser = useContext(APP_USER_CONTEXT);
  const reloadVersion = useSignal(0);
  const realtimeConnected = useSignal(false);
  const notice = useSignal("");
  const state = useStore<{
    appointments: DashboardAppointment[];
    unreadMessages: number;
    botReplies: number;
    humanReplies: number;
    repliesKnown: boolean;
    loadedAt: string;
    loading: boolean;
    error: boolean;
  }>({
    appointments: [],
    unreadMessages: 0,
    botReplies: 0,
    humanReplies: 0,
    repliesKnown: false,
    loadedAt: "",
    loading: true,
    error: false,
  });

  useVisibleTask$(async ({ track, cleanup }) => {
    track(() => reloadVersion.value);
    let current = true;
    cleanup(() => {
      current = false;
    });
    state.loading = true;
    state.error = false;

    try {
      const client = getSupabaseClient();
      const reference = new Date();
      const range = getBusinessDayRange(reference);
      // La asistencia mira siete días hacia atrás, así que la carga arranca
      // antes del día de hoy. Hacia adelante no se acota: el consultorio tiene
      // un volumen chico y recortar escondería señas pendientes lejanas.
      const metricsFrom = new Date(
        range.from.getTime() - ATTENDANCE_WINDOW_DAYS * 24 * 60 * 60 * 1_000,
      );
      const repliesFrom = new Date(
        reference.getTime() - ATTENDANCE_WINDOW_DAYS * 24 * 60 * 60 * 1_000,
      ).toISOString();

      const outboundSince = () =>
        client
          .from("messages")
          .select("id", { count: "exact", head: true })
          .eq("direction", "outbound")
          .gte("created_at", repliesFrom);

      const [appointments, conversations, botReplies, humanReplies] =
        await Promise.all([
          loadDashboardAppointments(client, metricsFrom.toISOString()),
          client
            .from("conversations")
            .select("unread_count")
            .eq("status", "open"),
          // `sent_by` queda en null cuando responde la automatización y guarda
          // el usuario cuando contesta una persona desde la bandeja.
          outboundSince().is("sent_by", null),
          outboundSince().not("sent_by", "is", null),
        ]);

      if (conversations.error) throw conversations.error;
      if (!current) return;

      state.appointments = appointments;
      state.unreadMessages = (conversations.data ?? []).reduce(
        (total, row) => total + Number(row.unread_count ?? 0),
        0,
      );
      // El reparto es informativo: si falla, el resto del inicio sigue sirviendo
      // y la tarjeta dice que no hay dato en lugar de inventar un cero.
      state.repliesKnown = !botReplies.error && !humanReplies.error;
      state.botReplies = botReplies.count ?? 0;
      state.humanReplies = humanReplies.count ?? 0;
      state.loadedAt = reference.toISOString();
    } catch {
      if (current) state.error = true;
    } finally {
      if (current) state.loading = false;
    }
  });

  // Realtime sobre turnos, conversaciones y mensajes: comprobantes y estados
  // aparecen sin esperar al próximo intervalo.
  // eslint-disable-next-line qwik/no-use-visible-task
  useVisibleTask$(({ cleanup }) => {
    let watch: { unsubscribe: () => void } | null = null;
    try {
      watch = watchRealtimeTables({
        client: getSupabaseClient(),
        channelName: "dashboard-overview",
        tables: ["appointments", "conversations", "messages"],
        onChange: () => {
          if (!document.hidden) reloadVersion.value += 1;
        },
        onConnectionChange: (connected) => {
          realtimeConnected.value = connected;
        },
      });
    } catch {
      // Sin Realtime el inicio sigue vivo con el refresco por intervalo.
      realtimeConnected.value = false;
    }
    cleanup(() => watch?.unsubscribe());
  });

  // Respaldo por intervalo. Un socket caído es silencioso, así que el refresco
  // periódico nunca se apaga del todo: sólo se espacia cuando Realtime responde.
  // eslint-disable-next-line qwik/no-use-visible-task
  useVisibleTask$(({ track, cleanup }) => {
    const connected = track(() => realtimeConnected.value);
    const refresh = () => {
      if (!document.hidden) reloadVersion.value += 1;
    };
    const interval = window.setInterval(refresh, connected ? 300_000 : 60_000);
    document.addEventListener("visibilitychange", refresh);
    cleanup(() => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", refresh);
    });
  });

  const now = state.loadedAt ? new Date(state.loadedAt) : new Date();
  const activeAppointments = state.appointments.filter(
    (appointment) =>
      appointment.status !== "cancelled" &&
      appointment.depositStatus !== "expired",
  );
  const allUpcomingAppointments = activeAppointments.filter(
    (appointment) =>
      (appointment.status === "scheduled" ||
        appointment.status === "confirmed") &&
      new Date(appointment.startsAt).getTime() >= now.getTime(),
  );
  const upcomingAppointments = allUpcomingAppointments.slice(0, 8);
  const proofAppointments = allUpcomingAppointments.filter(
    (appointment) => appointment.depositStatus === "proof_received",
  );
  const pendingDeposits = allUpcomingAppointments.filter(
    (appointment) => appointment.depositStatus === "pending",
  );
  const nextAppointment = upcomingAppointments[0];

  // Las métricas se calculan sobre lo ya cargado, sin consultas extra.
  const attendance = weeklyAttendance(state.appointments, now.getTime());
  const depositRevenue = projectedDepositRevenue(
    state.appointments,
    now.getTime(),
  );
  const replies = responseDistribution({
    bot: state.botReplies,
    human: state.humanReplies,
  });

  const todayDate = businessDateInput(now);
  const todayAgendaHref = agendaHref({ date: todayDate });
  const tomorrow = new Date(`${todayDate}T12:00:00Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const tomorrowAgendaHref = agendaHref({
    date: tomorrow.toISOString().slice(0, 10),
  });
  const hour = Number(
    formatBusinessDate(now, { hour: "numeric", hourCycle: "h23" }),
  );
  const greeting =
    hour < 12 ? "Buen día" : hour < 20 ? "Buenas tardes" : "Buenas noches";
  const nextAppointmentHref = nextAppointment
    ? agendaHref({
        date: businessDateInput(new Date(nextAppointment.startsAt)),
        appointmentId: nextAppointment.id,
      })
    : todayAgendaHref;
  const todayLabel = capitalize(
    formatBusinessDate(now, {
      weekday: "long",
      day: "numeric",
      month: "long",
    }),
  );

  return (
    <main class="section-shell">
      <AppNavigation active="home" />
      <section
        id="app-content"
        class="section-page dashboard-page"
        tabIndex={-1}
      >
        <header class="section-page-header dashboard-header dashboard-welcome">
          <div class="dashboard-welcome-copy">
            <span class="eyebrow">Tu consultorio hoy</span>
            <h1>
              {greeting}, {appUser.fullName.split(" ")[0]}
            </h1>
            <p>{todayLabel} · Consultorio de Gisela Lentz</p>
            <BotAutomationControl variant="home" />
            <nav class="dashboard-quick-actions" aria-label="Acciones rápidas">
              <Link class="primary-button" href={todayAgendaHref}>
                <Icon name="calendar" size={17} /> Abrir agenda
              </Link>
              <Link class="secondary-button" href="/app/inbox">
                <Icon name="message" size={17} /> Ver mensajes
              </Link>
              <Link class="secondary-button" href={tomorrowAgendaHref}>
                <Icon name="clock" size={17} /> Agenda de mañana
              </Link>
            </nav>
          </div>
        </header>

        <IntegrationHealthBanner />

        <GoogleCalendarStatusBlock variant="home" />

        <div class="dashboard-refresh">
          <span>
            {state.loadedAt ? (
              <>
                Última actualización:{" "}
                <time dateTime={state.loadedAt}>
                  {formatBusinessDate(new Date(state.loadedAt), {
                    timeStyle: "short",
                  })}
                </time>
              </>
            ) : (
              "Resumen del consultorio"
            )}
          </span>
          <button
            type="button"
            disabled={state.loading}
            onClick$={() => (reloadVersion.value += 1)}
          >
            {state.loading ? "Actualizando…" : "Actualizar"}
          </button>
        </div>

        {state.loading && !state.loadedAt ? (
          <div class="dashboard-state" aria-live="polite">
            <span class="small-spinner" aria-hidden="true" />
            <p>Preparando tu día…</p>
          </div>
        ) : state.error ? (
          <div class="dashboard-state" role="alert">
            <Icon name="info" size={25} />
            <strong>No pudimos cargar el resumen de hoy.</strong>
            <p>Revisá la conexión e intentá nuevamente.</p>
            <button
              class="secondary-button"
              type="button"
              onClick$={() => (reloadVersion.value += 1)}
            >
              Reintentar
            </button>
          </div>
        ) : (
          <>
            <h2 class="dashboard-section-title">Lo importante de hoy</h2>
            <section class="dashboard-metrics" aria-label="Resumen de hoy">
              <Link
                class="dashboard-card"
                href={nextAppointmentHref}
                aria-label="Abrir el próximo turno"
              >
                <span class="dashboard-card-icon next">
                  <Icon name="clock" size={19} />
                </span>
                <span>
                  <small>Próximo turno</small>
                  <strong>
                    {nextAppointment
                      ? formatBusinessDate(new Date(nextAppointment.startsAt), {
                          hour: "2-digit",
                          minute: "2-digit",
                          hour12: false,
                        })
                      : "—"}
                  </strong>
                  <em>
                    {nextAppointment
                      ? `${businessDateInput(new Date(nextAppointment.startsAt)) === todayDate ? "Hoy" : formatBusinessDate(new Date(nextAppointment.startsAt), { day: "numeric", month: "short" })} · ${nextAppointment.patientName}`
                      : "Sin próximos turnos"}
                  </em>
                </span>
              </Link>

              <Link
                class="dashboard-card"
                href="/app/appointments?deposit=proof_received"
                aria-label="Revisar comprobantes recibidos"
              >
                <span class="dashboard-card-icon messages">
                  <Icon name="message" size={19} />
                </span>
                <span>
                  <small>Comprobantes</small>
                  <strong>{proofAppointments.length}</strong>
                  <em>
                    {proofAppointments.length === 1
                      ? "seña para revisar"
                      : "señas para revisar"}
                  </em>
                </span>
              </Link>

              <Link
                class="dashboard-card"
                href="/app/appointments?deposit=pending"
                aria-label="Revisar turnos esperando seña"
              >
                <span class="dashboard-card-icon next">
                  <Icon name="clock" size={19} />
                </span>
                <span>
                  <small>Esperando seña</small>
                  <strong>{pendingDeposits.length}</strong>
                  <em>turnos pendientes</em>
                </span>
              </Link>

              <Link
                class="dashboard-card"
                href="/app/inbox?filter=unread"
                aria-label="Abrir mensajes sin leer"
              >
                <span class="dashboard-card-icon messages">
                  <Icon name="message" size={19} />
                </span>
                <span>
                  <small>Mensajes sin leer</small>
                  <strong>{state.unreadMessages}</strong>
                  <em>por leer</em>
                </span>
              </Link>
            </section>

            <h2 class="dashboard-section-title">Cómo viene la semana</h2>
            <section
              class="dashboard-metrics dashboard-metrics-secondary"
              aria-label={`Resumen de los últimos ${ATTENDANCE_WINDOW_DAYS} días`}
            >
              <article class="dashboard-card static">
                <span class="dashboard-card-icon next">
                  <Icon name="check-circle" size={19} />
                </span>
                <span>
                  <small>Asistencia ({ATTENDANCE_WINDOW_DAYS} días)</small>
                  <strong>
                    {attendance.rate === null ? "—" : `${attendance.rate}%`}
                  </strong>
                  <em>
                    {attendance.rate === null
                      ? "Todavía sin turnos cerrados"
                      : `${attendance.completed} atendidos · ${attendance.noShow} ausentes`}
                  </em>
                </span>
              </article>

              <Link
                class="dashboard-card"
                href="/app/appointments?deposit=pending"
                aria-label="Revisar las señas proyectadas"
              >
                <span class="dashboard-card-icon next">
                  <Icon name="file" size={19} />
                </span>
                <span>
                  <small>Señas por cobrar</small>
                  <strong>{formatArs(depositRevenue.pendingArs)}</strong>
                  <em>
                    {depositRevenue.confirmedArs > 0
                      ? `${formatArs(depositRevenue.confirmedArs)} ya confirmadas`
                      : "de turnos que todavía no ocurrieron"}
                    {depositRevenue.unknownAmountCount > 0
                      ? ` · ${depositRevenue.unknownAmountCount} sin monto`
                      : ""}
                  </em>
                </span>
              </Link>

              <article class="dashboard-card static">
                <span class="dashboard-card-icon messages">
                  <Icon name="bot" size={19} />
                </span>
                <span>
                  <small>Respuestas automáticas</small>
                  <strong>
                    {!state.repliesKnown || replies.botShare === null
                      ? "—"
                      : `${replies.botShare}%`}
                  </strong>
                  <em>
                    {!state.repliesKnown
                      ? "No pudimos calcular el reparto"
                      : replies.botShare === null
                        ? "Todavía sin respuestas enviadas"
                        : `${replies.bot} del bot · ${replies.human} escritas`}
                  </em>
                </span>
              </article>
            </section>

            <section
              class="dashboard-upcoming"
              aria-labelledby="upcoming-title"
            >
              <header>
                <div>
                  <span class="eyebrow">Agenda</span>
                  <h2 id="upcoming-title">Próximos turnos</h2>
                </div>
                <Link href={todayAgendaHref}>Ver agenda completa</Link>
              </header>

              {upcomingAppointments.length === 0 ? (
                <div class="dashboard-empty">
                  <span>
                    <Icon name="calendar" size={22} />
                  </span>
                  <strong>No hay próximos turnos.</strong>
                  <p>Cuando se cree uno, aparecerá acá.</p>
                </div>
              ) : (
                <div class="dashboard-appointment-list">
                  <div class="dashboard-list-head" aria-hidden="true">
                    <span>Hora</span>
                    <span>Paciente</span>
                    <span>Servicio</span>
                    <span>Estado</span>
                  </div>
                  <ol>
                    {upcomingAppointments.map((appointment) => (
                      <li key={appointment.id}>
                        <time dateTime={appointment.startsAt}>
                          <strong>
                            {formatBusinessDate(
                              new Date(appointment.startsAt),
                              {
                                hour: "2-digit",
                                minute: "2-digit",
                                hour12: false,
                              },
                            )}
                          </strong>
                          <small>
                            {capitalize(
                              formatBusinessDate(
                                new Date(appointment.startsAt),
                                {
                                  weekday: "short",
                                  day: "numeric",
                                  month: "short",
                                },
                              ),
                            )}
                          </small>
                        </time>
                        <Link
                          class="dashboard-patient dashboard-appointment-link"
                          href={agendaHref({
                            date: businessDateInput(
                              new Date(appointment.startsAt),
                            ),
                            appointmentId: appointment.id,
                          })}
                          aria-label={`Abrir el turno de ${appointment.patientName}`}
                        >
                          {appointment.patientName}
                        </Link>
                        <span class="dashboard-service">
                          {coverageAndDuration(
                            appointment.coverage,
                            appointment.durationMinutes,
                          )}
                        </span>
                        <span
                          class={`dashboard-status status-${appointmentStatusTone(appointment.status, appointment.depositStatus)}`}
                        >
                          {appointmentDisplayStatus(
                            appointment.status,
                            appointment.depositStatus,
                          )}
                        </span>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
            </section>
          </>
        )}
      </section>

      <QuickActionsFab
        onChanged$={$((message: string) => {
          notice.value = message;
          reloadVersion.value += 1;
        })}
      />

      {notice.value && (
        <div class="toast" role="status">
          <span>{notice.value}</span>
          <button
            type="button"
            aria-label="Cerrar aviso"
            onClick$={() => (notice.value = "")}
          >
            ×
          </button>
        </div>
      )}
    </main>
  );
});

export const head: DocumentHead = {
  title: getPageTitle("Inicio"),
  meta: [{ name: "description", content: APP_DESCRIPTION }],
};
