import {
  $,
  component$,
  useSignal,
  useStore,
  useVisibleTask$,
} from "@qwik.dev/core";
import { useLocation, type DocumentHead } from "@qwik.dev/router";
import "./agenda-print.css";
import { AppNavigation } from "~/components/app/AppNavigation";
import { ManualHelpLink } from "~/components/app/ManualHelpLink";
import { ManualAppointmentDrawer } from "~/components/appointments/ManualAppointmentDrawer";
import { RescheduleAppointmentDrawer } from "~/components/appointments/RescheduleAppointmentDrawer";
import { BusinessLogo } from "~/components/brand/BusinessLogo";
import { Icon } from "~/components/ui/Icon";
import { getPageTitle } from "~/config/business";
import {
  appointmentDisplayStatus,
  appointmentStatusTone,
  coverageAndDuration,
} from "~/lib/booking";
import {
  businessDateInput,
  formatBusinessDate,
  getBusinessCalendarDayRange,
} from "~/lib/date-time";
import type { ProfessionalOption, ServiceOption } from "~/lib/inbox-types";
import type { BookingDurationSettings, DepositStatus } from "~/lib/inbox-types";
import { confirmDepositAndNotify } from "~/lib/deposit-confirmation";
import { getSupabaseClient } from "~/lib/supabase/client";
import {
  loadAppointments,
  loadBookingDurationSettings,
  loadProfessionals,
  loadServices,
  type AppointmentListItem,
} from "~/lib/supabase/data";

const statusLabels: Record<AppointmentListItem["status"], string> = {
  scheduled: "Pendiente",
  confirmed: "Confirmado",
  cancelled: "Cancelado",
  completed: "Atendido",
  no_show: "No asistió",
};

const finalStatuses = new Set<AppointmentListItem["status"]>([
  "cancelled",
  "completed",
  "no_show",
]);

const idPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function safeId(value: string | null): string {
  return value && idPattern.test(value) ? value : "";
}

function safeDate(value: string | null): string {
  if (!value) return businessDateInput();
  try {
    getBusinessCalendarDayRange(value);
    return value;
  } catch {
    return businessDateInput();
  }
}

function safeStatus(value: string | null): AppointmentListItem["status"] | "" {
  return value && value in statusLabels
    ? (value as AppointmentListItem["status"])
    : "";
}

function safeDepositStatus(value: string | null): DepositStatus | "" {
  return value === "pending" || value === "proof_received" ? value : "";
}

function statusConfirmation(
  appointment: AppointmentListItem,
  status: AppointmentListItem["status"],
): string {
  const dateAndTime = formatBusinessDate(new Date(appointment.startsAt), {
    dateStyle: "full",
    timeStyle: "short",
  });
  const question =
    status === "cancelled"
      ? "¿Cancelar este turno?"
      : status === "completed"
        ? "¿Marcar este turno como atendido?"
        : "¿Marcar que el paciente no asistió?";

  return `${question}\n\nPaciente: ${appointment.contactName}\nFecha: ${dateAndTime}\n\nEsta acción cambia el estado final del turno.`;
}

function statusSuccessMessage(
  patientName: string,
  status: AppointmentListItem["status"],
): string {
  switch (status) {
    case "cancelled":
      return `Turno de ${patientName} cancelado.`;
    case "completed":
      return `Turno de ${patientName} marcado como atendido.`;
    case "no_show":
      return `Registraste que ${patientName} no asistió.`;
    case "confirmed":
      return `Turno de ${patientName} confirmado.`;
    default:
      return `Turno actualizado: ${statusLabels[status]}.`;
  }
}

function displayStatus(appointment: AppointmentListItem): string {
  return appointmentDisplayStatus(
    appointment.status,
    appointment.depositStatus,
  );
}

function statusTone(appointment: AppointmentListItem): string {
  return appointmentStatusTone(appointment.status, appointment.depositStatus);
}

function matchesStatusFilter(
  appointment: AppointmentListItem,
  filter: AppointmentListItem["status"] | "",
): boolean {
  if (!filter) return true;
  if (filter === "scheduled") {
    return (
      appointment.status === "scheduled" &&
      (appointment.depositStatus === "pending" ||
        appointment.depositStatus === "proof_received")
    );
  }
  if (filter === "confirmed") {
    return displayStatus(appointment) === "Confirmado";
  }
  if (filter === "cancelled") {
    return displayStatus(appointment) === "Cancelado";
  }
  return appointment.status === filter;
}

function dateRange(value: string): { from: string; to: string } {
  const { from, to } = getBusinessCalendarDayRange(value);
  return { from: from.toISOString(), to: to.toISOString() };
}

function shiftDate(value: string, days: number): string {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function formatSelectedDate(value: string): string {
  const label = new Intl.DateTimeFormat("es-AR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T12:00:00Z`));
  return `${label.charAt(0).toLocaleUpperCase("es-AR")}${label.slice(1)}`;
}

export default component$(() => {
  const location = useLocation();
  const requestedPatientId = safeId(location.url.searchParams.get("patient"));
  const selectedDate = useSignal(
    safeDate(location.url.searchParams.get("date")),
  );
  const query = useSignal("");
  const statusFilter = useSignal<AppointmentListItem["status"] | "">(
    safeStatus(location.url.searchParams.get("status")),
  );
  const depositFilter = useSignal<DepositStatus | "">(
    safeDepositStatus(location.url.searchParams.get("deposit")),
  );
  const futureDepositMode = useSignal(
    Boolean(depositFilter.value) && !location.url.searchParams.has("date"),
  );
  const selectedId = useSignal(
    safeId(location.url.searchParams.get("appointment")),
  );
  const creating = useSignal(Boolean(requestedPatientId));
  const rescheduling = useSignal(false);
  const savingStatus = useSignal<AppointmentListItem["status"] | "">("");
  const confirmingDeposit = useSignal(false);
  const reloadVersion = useSignal(0);
  const notice = useSignal("");
  const printState = useStore<{
    appointments: AppointmentListItem[];
    date: string;
    preparing: "" | "today" | "tomorrow";
    request: number;
  }>({
    appointments: [],
    date: businessDateInput(),
    preparing: "",
    request: 0,
  });
  const state = useStore<{
    appointments: AppointmentListItem[];
    professionals: ProfessionalOption[];
    services: ServiceOption[];
    bookingDurations: BookingDurationSettings;
    loading: boolean;
    error: boolean;
  }>({
    appointments: [],
    professionals: [],
    services: [],
    bookingDurations: { iomaMinutes: 0, privateMinutes: 0 },
    loading: true,
    error: false,
  });

  useVisibleTask$(async ({ track }) => {
    track(() => selectedDate.value);
    track(() => futureDepositMode.value);
    track(() => reloadVersion.value);
    state.loading = true;
    state.error = false;
    try {
      const range = dateRange(selectedDate.value);
      const client = getSupabaseClient();
      const [appointments, professionals, services, bookingDurations] =
        await Promise.all([
          loadAppointments(
            client,
            futureDepositMode.value ? new Date().toISOString() : range.from,
            futureDepositMode.value ? undefined : range.to,
          ),
          loadProfessionals(client),
          loadServices(client),
          loadBookingDurationSettings(client),
        ]);
      state.appointments = appointments;
      state.professionals = professionals;
      state.services = services;
      state.bookingDurations = bookingDurations;
    } catch {
      state.error = true;
    } finally {
      state.loading = false;
    }
  });

  useVisibleTask$(({ cleanup }) => {
    const client = getSupabaseClient();
    const channel = client
      .channel("agenda-realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "appointments" },
        () => (reloadVersion.value += 1),
      )
      .subscribe();
    cleanup(() => void client.removeChannel(channel));
  });

  // Printing must run in the browser after the independently loaded sheet is rendered.
  // eslint-disable-next-line qwik/no-use-visible-task
  useVisibleTask$(({ track }) => {
    const request = track(() => printState.request);
    if (request === 0) return;

    window.print();
    printState.preparing = "";
  });

  const preparePrint = $(async (target: "today" | "tomorrow") => {
    if (printState.preparing) return;

    printState.preparing = target;
    const today = businessDateInput();
    const targetDate = target === "today" ? today : shiftDate(today, 1);
    const range = dateRange(targetDate);

    try {
      const appointments = await loadAppointments(
        getSupabaseClient(),
        range.from,
        range.to,
      );
      printState.appointments = appointments.filter(
        (appointment) =>
          appointment.status !== "cancelled" &&
          appointment.depositStatus !== "expired",
      );
      printState.date = targetDate;
      printState.request += 1;
    } catch {
      printState.preparing = "";
      notice.value = "No pudimos preparar la agenda para imprimir.";
    }
  });

  const changeStatus = $(
    async (
      appointment: AppointmentListItem,
      status: AppointmentListItem["status"],
    ) => {
      if (savingStatus.value) return;
      if (
        (status === "completed" || status === "no_show") &&
        new Date(appointment.startsAt).getTime() > Date.now()
      ) {
        notice.value =
          "Podrás registrar la asistencia después de la hora del turno.";
        return;
      }
      if (
        finalStatuses.has(status) &&
        !window.confirm(statusConfirmation(appointment, status))
      ) {
        return;
      }

      savingStatus.value = status;
      try {
        const { error } = await getSupabaseClient().rpc(
          "update_appointment_status",
          { p_appointment_id: appointment.id, p_status: status },
        );
        if (error) {
          notice.value =
            "No pudimos cambiar el estado. No se hicieron cambios; intentá de nuevo.";
          return;
        }
        selectedId.value = "";
        reloadVersion.value += 1;
        notice.value = statusSuccessMessage(appointment.contactName, status);
      } catch {
        notice.value =
          "No pudimos cambiar el estado. No se hicieron cambios; intentá de nuevo.";
      } finally {
        savingStatus.value = "";
      }
    },
  );

  const confirmDeposit = $(async (appointment: AppointmentListItem) => {
    if (confirmingDeposit.value) return;
    if (
      !window.confirm(
        `¿Confirmar la seña de ${appointment.contactName}? El turno quedará confirmado.`,
      )
    ) {
      return;
    }
    confirmingDeposit.value = true;
    try {
      const result = await confirmDepositAndNotify(getSupabaseClient(), {
        appointmentId: appointment.id,
        contactId: appointment.contactId,
        startsAt: appointment.startsAt,
      });
      if (!result.confirmed) {
        notice.value = "No pudimos confirmar la seña. Intentá nuevamente.";
        return;
      }
      selectedId.value = "";
      reloadVersion.value += 1;
      notice.value = result.notified
        ? `Seña confirmada. Avisamos a ${appointment.contactName} por WhatsApp.`
        : `Seña confirmada. El turno quedó guardado, pero no pudimos enviar el aviso por WhatsApp.`;
    } catch {
      notice.value = "No pudimos confirmar la seña. Intentá nuevamente.";
    } finally {
      confirmingDeposit.value = false;
    }
  });

  const normalizedQuery = query.value.trim().toLocaleLowerCase("es-AR");
  const visibleAppointments = state.appointments
    .filter(
      (appointment) =>
        (!normalizedQuery ||
          appointment.contactName
            .toLocaleLowerCase("es-AR")
            .includes(normalizedQuery) ||
          appointment.contactPhone.includes(normalizedQuery) ||
          appointment.serviceName
            .toLocaleLowerCase("es-AR")
            .includes(normalizedQuery)) &&
        matchesStatusFilter(appointment, statusFilter.value),
    )
    .filter(
      (appointment) =>
        !depositFilter.value ||
        ((appointment.status === "scheduled" ||
          appointment.status === "confirmed") &&
          appointment.depositStatus === depositFilter.value),
    );
  const selectedAppointment = state.appointments.find(
    (appointment) => appointment.id === selectedId.value,
  );
  const selectedAppointmentHasStarted = selectedAppointment
    ? new Date(selectedAppointment.startsAt).getTime() <= Date.now()
    : false;
  const selectedAppointmentActive = selectedAppointment
    ? (selectedAppointment.status === "scheduled" ||
        selectedAppointment.status === "confirmed") &&
      selectedAppointment.depositStatus !== "expired"
    : false;
  const isToday = selectedDate.value === businessDateInput();
  const noticeIsError = notice.value.startsWith("No pudimos");

  return (
    <main class="section-shell">
      <AppNavigation active="appointments" />
      <section
        id="app-content"
        class={{
          "section-page": true,
          "agenda-page": true,
          "future-deposit-mode": futureDepositMode.value,
        }}
        tabIndex={-1}
      >
        <header class="section-page-header">
          <div>
            <span class="eyebrow">Agenda</span>
            <h1>
              {futureDepositMode.value
                ? depositFilter.value === "proof_received"
                  ? "Comprobantes recibidos"
                  : "Esperando seña"
                : isToday
                  ? "Hoy"
                  : "Turnos"}
            </h1>
            <p>
              {futureDepositMode.value
                ? "Todos los próximos turnos"
                : formatSelectedDate(selectedDate.value)}
            </p>
          </div>
          <div class="agenda-header-actions">
            <ManualHelpLink
              section="turnos"
              label="¿Cómo funcionan los turnos?"
            />
            <button
              class="secondary-button agenda-print-action"
              type="button"
              disabled={Boolean(printState.preparing)}
              onClick$={() => preparePrint("today")}
            >
              <Icon name="printer" size={17} />
              {printState.preparing === "today"
                ? "Preparando…"
                : "Imprimir hoy"}
            </button>
            <button
              class="secondary-button agenda-print-action"
              type="button"
              disabled={Boolean(printState.preparing)}
              onClick$={() => preparePrint("tomorrow")}
            >
              <Icon name="printer" size={17} />
              {printState.preparing === "tomorrow"
                ? "Preparando…"
                : "Imprimir mañana"}
            </button>
            <button
              class="primary-button"
              type="button"
              onClick$={() => (creating.value = true)}
            >
              <Icon name="plus" size={17} /> Nuevo turno
            </button>
          </div>
        </header>

        <div class="section-toolbar agenda-toolbar">
          <div class="agenda-date-nav" aria-label="Cambiar día">
            <button
              class="secondary-button small"
              type="button"
              aria-label="Día anterior"
              onClick$={() => {
                futureDepositMode.value = false;
                selectedDate.value = shiftDate(selectedDate.value, -1);
              }}
            >
              ←
            </button>
            <input
              aria-label="Fecha de agenda"
              type="date"
              value={selectedDate.value}
              onInput$={(_, element) => {
                if (element.value) {
                  futureDepositMode.value = false;
                  selectedDate.value = element.value;
                } else element.value = selectedDate.value;
              }}
            />
            <button
              class="secondary-button small"
              type="button"
              aria-label="Día siguiente"
              onClick$={() => {
                futureDepositMode.value = false;
                selectedDate.value = shiftDate(selectedDate.value, 1);
              }}
            >
              →
            </button>
            {!isToday && (
              <button
                class="filter-pill"
                type="button"
                onClick$={() => {
                  futureDepositMode.value = false;
                  selectedDate.value = businessDateInput();
                }}
              >
                Volver a hoy
              </button>
            )}
          </div>
          <label class="search-field compact-search">
            <Icon name="search" size={17} />
            <span class="sr-only">Buscar paciente o servicio</span>
            <input
              type="search"
              value={query.value}
              placeholder="Buscar paciente o servicio"
              autoComplete="off"
              enterKeyHint="search"
              onInput$={(_, element) => (query.value = element.value)}
            />
            {query.value && (
              <button
                class="search-clear"
                type="button"
                aria-label="Limpiar búsqueda"
                title="Limpiar búsqueda"
                onClick$={() => (query.value = "")}
              >
                <Icon name="x" size={16} />
              </button>
            )}
          </label>
          <label class="agenda-status-filter">
            <span>Mostrar</span>
            <div class="select-wrap">
              <select
                value={statusFilter.value}
                onChange$={(_, element) =>
                  (statusFilter.value =
                    element.value as typeof statusFilter.value)
                }
              >
                <option value="">Todos los estados</option>
                <option value="scheduled">Esperando seña o comprobante</option>
                <option value="confirmed">Confirmados</option>
                <option value="completed">Atendidos</option>
                <option value="no_show">No asistieron</option>
                <option value="cancelled">Cancelados</option>
              </select>
              <Icon name="chevron-down" size={17} />
            </div>
          </label>
          {depositFilter.value && (
            <button
              class="filter-pill active"
              type="button"
              onClick$={() => {
                depositFilter.value = "";
                futureDepositMode.value = false;
              }}
            >
              {depositFilter.value === "proof_received"
                ? "Comprobantes recibidos"
                : "Esperando seña"}{" "}
              ×
            </button>
          )}
        </div>

        <div class="agenda-list">
          <div class="agenda-label">
            <span>
              {visibleAppointments.length}{" "}
              {visibleAppointments.length === 1 ? "turno" : "turnos"}
            </span>
            <i />
          </div>
          {state.loading ? (
            <div class="section-empty">
              <span class="small-spinner" />
              <p>Cargando turnos…</p>
            </div>
          ) : state.error ? (
            <div class="section-empty">
              <Icon name="alert" size={23} />
              <p>No pudimos cargar la agenda.</p>
              <button type="button" onClick$={() => (reloadVersion.value += 1)}>
                Reintentar
              </button>
            </div>
          ) : visibleAppointments.length === 0 &&
            state.appointments.length > 0 ? (
            <div class="section-empty">
              <Icon name="search" size={25} />
              <p>No encontramos turnos con esos filtros.</p>
              <button
                type="button"
                onClick$={() => {
                  query.value = "";
                  statusFilter.value = "";
                  depositFilter.value = "";
                  futureDepositMode.value = false;
                }}
              >
                Ver todos los turnos del día
              </button>
            </div>
          ) : visibleAppointments.length === 0 ? (
            <div class="section-empty">
              <Icon name="calendar" size={25} />
              <p>No hay turnos para este día.</p>
              <button type="button" onClick$={() => (creating.value = true)}>
                Crear un turno
              </button>
            </div>
          ) : (
            visibleAppointments.map((appointment) => {
              const statusLabel = displayStatus(appointment);
              return (
                <button
                  class="agenda-item"
                  type="button"
                  key={appointment.id}
                  onClick$={() => (selectedId.value = appointment.id)}
                >
                  <time>
                    {futureDepositMode.value && (
                      <small>
                        {formatBusinessDate(new Date(appointment.startsAt), {
                          weekday: "short",
                          day: "numeric",
                          month: "short",
                        })}
                      </small>
                    )}
                    <strong>
                      {formatBusinessDate(new Date(appointment.startsAt), {
                        hour: "2-digit",
                        minute: "2-digit",
                        hour12: false,
                      })}
                    </strong>
                  </time>
                  <span class="agenda-avatar">
                    {appointment.contactName
                      .split(/\s+/)
                      .slice(0, 2)
                      .map((part) => part[0])
                      .join("")}
                  </span>
                  <span class="agenda-copy">
                    <strong>{appointment.contactName}</strong>
                    <small>
                      {coverageAndDuration(
                        appointment.coverage,
                        appointment.durationMinutes,
                      )}
                    </small>
                  </span>
                  <span
                    class={`status-badge status-${statusTone(appointment)}`}
                  >
                    {statusLabel}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </section>

      <section class="agenda-print-sheet" aria-label="Agenda para imprimir">
        <header class="agenda-print-header">
          <div class="agenda-print-brand">
            <BusinessLogo />
            <p>Agenda de turnos</p>
          </div>
          <div class="agenda-print-date">
            <strong>{formatSelectedDate(printState.date)}</strong>
            <span>
              {printState.appointments.length}{" "}
              {printState.appointments.length === 1 ? "turno" : "turnos"}
            </span>
          </div>
        </header>

        {printState.appointments.length === 0 ? (
          <p class="agenda-print-empty">No hay turnos para este día.</p>
        ) : (
          <table class="agenda-print-table">
            <thead>
              <tr>
                <th scope="col">Hora</th>
                <th scope="col">Paciente</th>
                <th scope="col">Teléfono</th>
                <th scope="col">Servicio</th>
                <th scope="col">Estado</th>
                <th scope="col">Nota administrativa</th>
              </tr>
            </thead>
            <tbody>
              {printState.appointments.map((appointment) => (
                <tr key={appointment.id}>
                  <td>
                    {formatBusinessDate(new Date(appointment.startsAt), {
                      hour: "2-digit",
                      minute: "2-digit",
                      hour12: false,
                    })}
                  </td>
                  <td>
                    <span>{appointment.contactName}</span>
                  </td>
                  <td>{appointment.contactPhone || "—"}</td>
                  <td>
                    {appointment.serviceName} ·{" "}
                    {coverageAndDuration(
                      appointment.coverage,
                      appointment.durationMinutes,
                    )}
                  </td>
                  <td>{displayStatus(appointment)}</td>
                  <td>{appointment.internalNote || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {selectedAppointment && !rescheduling.value && (
        <div
          class="drawer-layer"
          role="presentation"
          onClick$={() => (selectedId.value = "")}
        >
          <aside
            class="drawer appointment-detail-drawer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="appointment-detail-title"
            onClick$={(event) => event.stopPropagation()}
          >
            <header class="drawer-header">
              <div>
                <span class="eyebrow">Detalle</span>
                <h2 id="appointment-detail-title">Turno</h2>
              </div>
              <button
                class="icon-button"
                type="button"
                aria-label="Cerrar"
                onClick$={() => (selectedId.value = "")}
              >
                <Icon name="x" size={20} />
              </button>
            </header>
            <div class="drawer-content appointment-detail-content">
              <h3>{selectedAppointment.contactName}</h3>
              <p>{selectedAppointment.contactPhone}</p>
              <dl>
                <div>
                  <dt>Fecha y hora</dt>
                  <dd>
                    {formatBusinessDate(
                      new Date(selectedAppointment.startsAt),
                      { dateStyle: "full", timeStyle: "short" },
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Servicio</dt>
                  <dd>{selectedAppointment.serviceName}</dd>
                </div>
                <div>
                  <dt>Cobertura y duración</dt>
                  <dd>
                    {coverageAndDuration(
                      selectedAppointment.coverage,
                      selectedAppointment.durationMinutes,
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Profesional</dt>
                  <dd>{selectedAppointment.professionalName}</dd>
                </div>
                <div>
                  <dt>Estado</dt>
                  <dd>{displayStatus(selectedAppointment)}</dd>
                </div>
                {selectedAppointment.internalNote && (
                  <div>
                    <dt>Nota administrativa</dt>
                    <dd>{selectedAppointment.internalNote}</dd>
                  </div>
                )}
              </dl>
              {selectedAppointmentActive && !selectedAppointmentHasStarted && (
                <p class="appointment-status-help">
                  Podrás marcar “Atendido” o “No asistió” después de la hora del
                  turno.
                </p>
              )}
              <div class="appointment-actions-grid">
                {selectedAppointment.depositStatus === "proof_received" &&
                  selectedAppointment.depositProofMessageId && (
                    <a
                      class="secondary-button"
                      href={`/app/inbox?patient=${selectedAppointment.contactId}&message=${selectedAppointment.depositProofMessageId}`}
                    >
                      Ver comprobante
                    </a>
                  )}
                {selectedAppointment.depositStatus === "proof_received" && (
                  <button
                    class="primary-button"
                    type="button"
                    disabled={
                      Boolean(savingStatus.value) || confirmingDeposit.value
                    }
                    onClick$={() => confirmDeposit(selectedAppointment)}
                  >
                    {confirmingDeposit.value
                      ? "Confirmando…"
                      : "Confirmar seña"}
                  </button>
                )}
                {selectedAppointmentActive && (
                  <button
                    class="secondary-button"
                    type="button"
                    disabled={Boolean(savingStatus.value)}
                    onClick$={() => (rescheduling.value = true)}
                  >
                    Reprogramar
                  </button>
                )}
                {selectedAppointmentActive && (
                  <button
                    class="secondary-button"
                    type="button"
                    disabled={
                      Boolean(savingStatus.value) ||
                      !selectedAppointmentHasStarted
                    }
                    onClick$={() =>
                      changeStatus(selectedAppointment, "completed")
                    }
                  >
                    {savingStatus.value === "completed"
                      ? "Guardando…"
                      : "Marcar atendido"}
                  </button>
                )}
                {selectedAppointmentActive && (
                  <button
                    class="secondary-button"
                    type="button"
                    disabled={
                      Boolean(savingStatus.value) ||
                      !selectedAppointmentHasStarted
                    }
                    onClick$={() =>
                      changeStatus(selectedAppointment, "no_show")
                    }
                  >
                    {savingStatus.value === "no_show"
                      ? "Guardando…"
                      : "No asistió"}
                  </button>
                )}
                {selectedAppointmentActive && (
                  <button
                    class="secondary-button danger-button"
                    type="button"
                    disabled={Boolean(savingStatus.value)}
                    onClick$={() =>
                      changeStatus(selectedAppointment, "cancelled")
                    }
                  >
                    {savingStatus.value === "cancelled"
                      ? "Guardando…"
                      : "Cancelar turno"}
                  </button>
                )}
              </div>
            </div>
          </aside>
        </div>
      )}

      {creating.value && (
        <ManualAppointmentDrawer
          professionals={state.professionals}
          services={state.services}
          bookingDurations={state.bookingDurations}
          initialDate={selectedDate.value}
          initialPatientId={requestedPatientId || undefined}
          onClose$={() => (creating.value = false)}
          onSaved$={(message) => {
            creating.value = false;
            notice.value = message;
            reloadVersion.value += 1;
          }}
        />
      )}

      {rescheduling.value && selectedAppointment && (
        <RescheduleAppointmentDrawer
          appointment={selectedAppointment}
          bookingDurations={state.bookingDurations}
          onClose$={() => (rescheduling.value = false)}
          onSaved$={(message) => {
            rescheduling.value = false;
            selectedId.value = "";
            notice.value = message;
            reloadVersion.value += 1;
          }}
        />
      )}

      {notice.value && (
        <div
          class={{ toast: true, error: noticeIsError }}
          role={noticeIsError ? "alert" : "status"}
          aria-live={noticeIsError ? "assertive" : "polite"}
        >
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
  title: getPageTitle("Agenda"),
  meta: [
    { name: "description", content: "Agenda diaria y gestión de turnos." },
  ],
};
