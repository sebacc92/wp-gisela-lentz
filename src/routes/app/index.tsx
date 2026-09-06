import {
  component$,
  useSignal,
  useStore,
  useVisibleTask$,
} from "@qwik.dev/core";
import type { DocumentHead } from "@qwik.dev/router";
import { Link } from "@qwik.dev/router";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AppNavigation } from "~/components/app/AppNavigation";
import { BotAutomationControl } from "~/components/app/BotAutomationControl";
import { GoogleCalendarStatusBlock } from "~/components/app/GoogleCalendarStatusBlock";
import { Icon } from "~/components/ui/Icon";
import {
  APP_DESCRIPTION,
  BUSINESS_CONFIG,
  getPageTitle,
} from "~/config/business";
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
import type { DepositStatus, PatientCoverage } from "~/lib/inbox-types";
import { getSupabaseClient } from "~/lib/supabase/client";

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
  contact_id: string;
  contacts: RelatedName | RelatedName[] | null;
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
  contactId: string;
}

const baseAppointmentSelect =
  "id,contact_id,starts_at,status,coverage,duration_minutes,deposit_status,hold_expires_at,deposit_proof_message_id,contacts!appointments_contact_id_fkey(name)";

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
      patientName: singleRelation(row.contacts)?.name ?? "Paciente",
      serviceName:
        singleRelation(row.services)?.name ?? "Sin servicio asignado",
      coverage: row.coverage,
      durationMinutes: row.duration_minutes,
      depositStatus,
      depositProofMessageId: row.deposit_proof_message_id,
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
    .select(`${baseAppointmentSelect},services(name)`)
    .gte("starts_at", fromIso)
    .order("starts_at");

  if (!withServices.error) {
    return mapAppointments(
      (withServices.data ?? []) as unknown as AppointmentRow[],
    );
  }

  // `services` is added by the Gisela migration. Until it is applied, the
  // dashboard remains operational with the existing appointment schema.
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
  const reloadVersion = useSignal(0);
  const state = useStore<{
    appointments: DashboardAppointment[];
    unreadMessages: number;
    loadedAt: string;
    loading: boolean;
    error: boolean;
  }>({
    appointments: [],
    unreadMessages: 0,
    loadedAt: "",
    loading: true,
    error: false,
  });

  useVisibleTask$(async ({ track }) => {
    track(() => reloadVersion.value);
    state.loading = true;
    state.error = false;

    try {
      const client = getSupabaseClient();
      const reference = new Date();
      const range = getBusinessDayRange(reference);
      const [appointments, conversations] = await Promise.all([
        // El consultorio tiene un volumen acotado: cargar todos los turnos
        // futuros evita ocultar señas pendientes por estar fuera de un rango.
        loadDashboardAppointments(client, range.from.toISOString()),
        client
          .from("conversations")
          .select("unread_count")
          .eq("status", "open"),
      ]);

      if (conversations.error) throw conversations.error;

      state.appointments = appointments;
      state.unreadMessages = (conversations.data ?? []).reduce(
        (total, row) => total + Number(row.unread_count ?? 0),
        0,
      );
      state.loadedAt = reference.toISOString();
    } catch {
      state.error = true;
    } finally {
      state.loading = false;
    }
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
  const todayDate = businessDateInput(now);
  const todayAgendaHref = agendaHref({ date: todayDate });
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
            <h1>Buen día, {BUSINESS_CONFIG.name.split(" ")[0]}</h1>
            <p>{todayLabel}. Acá tenés todo lo importante, sin vueltas.</p>
            <BotAutomationControl variant="home" />
            <nav class="dashboard-quick-actions" aria-label="Acciones rápidas">
              <Link class="primary-button" href={todayAgendaHref}>
                <Icon name="calendar" size={17} /> Abrir agenda
              </Link>
              <Link class="secondary-button" href="/app/inbox">
                <Icon name="message" size={17} /> Ver mensajes
              </Link>
            </nav>
          </div>
        </header>

        <GoogleCalendarStatusBlock variant="home" />

        {state.loading ? (
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
                    {nextAppointment?.patientName ?? "Sin próximos turnos"}
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
                  <em>sin responder</em>
                </span>
              </Link>
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
    </main>
  );
});

export const head: DocumentHead = {
  title: getPageTitle("Inicio"),
  meta: [{ name: "description", content: APP_DESCRIPTION }],
};
