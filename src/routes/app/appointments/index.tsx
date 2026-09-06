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
import { GoogleCalendarStatusBlock } from "~/components/app/GoogleCalendarStatusBlock";
import { ManualHelpLink } from "~/components/app/ManualHelpLink";
import { ConvertBlockDrawer } from "~/components/appointments/ConvertBlockDrawer";
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
import {
  confirmDepositManually,
  describeDepositConfirmationError,
  reviewDepositProof,
  type DepositReviewDecision,
} from "~/lib/deposit-review";
import { getSupabaseClient } from "~/lib/supabase/client";
import {
  loadAppointments,
  loadBookingDurationSettings,
  loadCalendarBlocks,
  loadDepositProofReviews,
  loadProfessionals,
  loadServices,
  type AppointmentListItem,
  type CalendarBlock,
  type DepositProofReview,
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
  const reviewingDeposit = useSignal<DepositReviewDecision | "">("");
  const convertingBlockId = useSignal("");
  const detailRef = useSignal<HTMLElement>();
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
    blocks: CalendarBlock[];
    depositReviews: DepositProofReview[];
    isAdmin: boolean;
    loading: boolean;
    error: boolean;
  }>({
    appointments: [],
    professionals: [],
    services: [],
    bookingDurations: { iomaMinutes: 0, privateMinutes: 0 },
    blocks: [],
    depositReviews: [],
    isAdmin: false,
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
      const fromIso = futureDepositMode.value
        ? new Date().toISOString()
        : range.from;
      const toIso = futureDepositMode.value ? undefined : range.to;
      const [appointments, professionals, services, bookingDurations, blocks] =
        await Promise.all([
          loadAppointments(client, fromIso, toIso),
          loadProfessionals(client),
          loadServices(client),
          loadBookingDurationSettings(client),
          loadCalendarBlocks(client, fromIso, toIso),
        ]);
      state.appointments = appointments;
      state.professionals = professionals;
      state.services = services;
      state.bookingDurations = bookingDurations;
      state.blocks = blocks;
      state.depositReviews = await loadDepositProofReviews(
        client,
        appointments.map((appointment) => appointment.id),
      ).catch((): DepositProofReview[] => []);
      const { data: user } = await client.auth.getUser();
      if (user.user) {
        const { data: profile } = await client
          .from("profiles")
          .select("role")
          .eq("id", user.user.id)
          .maybeSingle();
        state.isAdmin = profile?.role === "ADMIN";
      }
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

  // El detalle es un diálogo modal: al abrirlo recibe el foco y al cerrarlo lo
  // devuelve a la fila que lo abrió, para que el teclado no quede perdido.
  // eslint-disable-next-line qwik/no-use-visible-task
  useVisibleTask$(({ track, cleanup }) => {
    const openId = track(() => selectedId.value);
    if (!openId) return;
    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : undefined;
    detailRef.value?.focus();
    cleanup(() => {
      if (previousFocus && document.contains(previousFocus)) {
        previousFocus.focus();
      }
    });
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
    if (confirmingDeposit.value || reviewingDeposit.value) return;
    const dateAndTime = formatBusinessDate(new Date(appointment.startsAt), {
      dateStyle: "full",
      timeStyle: "short",
    });
    if (
      !window.confirm(
        `¿Confirmar la seña y el turno?\n\nPaciente: ${appointment.contactName}\nFecha: ${dateAndTime}\nServicio: ${appointment.serviceName}\n\nQueda registrado como tu decisión: el sistema no verifica la transferencia con el banco. El turno queda confirmado y se le avisa por WhatsApp.`,
      )
    ) {
      return;
    }
    confirmingDeposit.value = true;
    try {
      const result = await confirmDepositManually(getSupabaseClient(), {
        appointmentId: appointment.id,
        contactId: appointment.contactId,
        startsAt: appointment.startsAt,
      });
      if (!result.confirmed) {
        notice.value = describeDepositConfirmationError(
          result.error ?? "UNKNOWN",
        );
        return;
      }
      selectedId.value = "";
      reloadVersion.value += 1;
      notice.value = result.alreadyConfirmed
        ? `El turno de ${appointment.contactName} ya estaba confirmado.`
        : result.notified
          ? `Seña confirmada. Avisamos a ${appointment.contactName} por WhatsApp.`
          : "Seña confirmada. El turno quedó guardado, pero no pudimos enviar el aviso por WhatsApp.";
    } catch {
      notice.value = "No pudimos confirmar la seña. Intentá nuevamente.";
    } finally {
      confirmingDeposit.value = false;
    }
  });

  const decideDepositProof = $(
    async (
      appointment: AppointmentListItem,
      decision: DepositReviewDecision,
    ) => {
      if (confirmingDeposit.value || reviewingDeposit.value) return;
      const question =
        decision === "rejected"
          ? `¿Rechazar el comprobante de ${appointment.contactName}?\n\nSe le avisa por WhatsApp y el turno sigue sin confirmar.`
          : `¿Pedirle a ${appointment.contactName} otro comprobante?\n\nSe le envía un mensaje para que mande una imagen más clara.`;
      if (!window.confirm(question)) return;

      reviewingDeposit.value = decision;
      try {
        const result = await reviewDepositProof(getSupabaseClient(), {
          appointmentId: appointment.id,
          contactId: appointment.contactId,
          decision,
          notify: true,
        });
        if (result.error) {
          notice.value =
            "No pudimos registrar la revisión. No se hicieron cambios; intentá de nuevo.";
          return;
        }
        reloadVersion.value += 1;
        notice.value = !result.changed
          ? "Ese comprobante ya había sido revisado."
          : decision === "rejected"
            ? result.notified
              ? "Comprobante rechazado. Le avisamos por WhatsApp."
              : "Comprobante rechazado. No pudimos enviar el aviso por WhatsApp."
            : result.notified
              ? "Le pedimos otro comprobante por WhatsApp."
              : "Registramos el pedido, pero no pudimos enviar el mensaje por WhatsApp.";
      } catch {
        notice.value =
          "No pudimos registrar la revisión. No se hicieron cambios; intentá de nuevo.";
      } finally {
        reviewingDeposit.value = "";
      }
    },
  );

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
  const selectedReview = selectedAppointment
    ? state.depositReviews.find(
        (review) => review.appointmentId === selectedAppointment.id,
      )
    : undefined;
  const selectedProofMessageId =
    selectedAppointment?.depositProofMessageId ??
    selectedReview?.proofMessageId ??
    null;
  // La confirmación manual no exige que la IA haya podido leer nada: alcanza
  // con que la pre-reserva siga viva. El RPC vuelve a verificar el rol ADMIN.
  const canConfirmDeposit = Boolean(
    selectedAppointment &&
    state.isAdmin &&
    selectedAppointment.status === "scheduled" &&
    selectedAppointment.depositStatus !== "expired" &&
    selectedAppointment.depositStatus !== "not_required",
  );
  const canReviewProof = Boolean(
    canConfirmDeposit && (selectedProofMessageId || selectedReview),
  );
  const depositBadgeLabel = !selectedAppointment
    ? ""
    : selectedAppointment.depositStatus === "confirmed"
      ? "Seña confirmada"
      : selectedAppointment.depositStatus === "not_required"
        ? "Sin seña"
        : selectedAppointment.depositStatus === "expired"
          ? "Seña vencida"
          : selectedAppointment.depositStatus === "proof_received"
            ? "Comprobante recibido"
            : "Seña pendiente";
  const convertingBlock = state.blocks.find(
    (block) => block.googleEventId === convertingBlockId.value,
  );
  const detailBusy =
    Boolean(savingStatus.value) ||
    confirmingDeposit.value ||
    Boolean(reviewingDeposit.value);
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

        <GoogleCalendarStatusBlock variant="agenda" />

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

        {state.blocks.length > 0 && (
          <section
            class="agenda-blocks"
            aria-label="Bloqueos de Google Calendar"
          >
            <h2>Bloqueos de Google Calendar</h2>
            <ul>
              {state.blocks.map((block) => (
                <li key={block.googleEventId}>
                  <strong>
                    {block.allDay ? (
                      "Todo el día"
                    ) : (
                      <>
                        {formatBusinessDate(new Date(block.startsAt), {
                          timeStyle: "short",
                        })}
                        {" – "}
                        {formatBusinessDate(new Date(block.endsAt), {
                          timeStyle: "short",
                        })}
                      </>
                    )}
                  </strong>
                  <span>{block.summary || "Evento sin título"}</span>
                  {state.isAdmin && (
                    <button
                      class="secondary-button agenda-block-action"
                      type="button"
                      onClick$={() =>
                        (convertingBlockId.value = block.googleEventId)
                      }
                    >
                      Convertir en turno
                    </button>
                  )}
                </li>
              ))}
            </ul>
            <small>
              Vienen de un evento creado a mano en Google Calendar. Ocupan el
              horario, pero no son turnos de pacientes.
            </small>
          </section>
        )}

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
          onClick$={() => {
            if (!detailBusy) selectedId.value = "";
          }}
        >
          <aside
            ref={detailRef}
            class="drawer appointment-detail-drawer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="appointment-detail-title"
            aria-busy={detailBusy}
            tabIndex={-1}
            stoppropagation:click
            onKeyDown$={(event) => {
              if (event.key === "Escape" && !detailBusy) {
                event.preventDefault();
                selectedId.value = "";
              }
            }}
          >
            <header class="drawer-header detail-drawer-header">
              <div>
                <span class="eyebrow">Detalle del turno</span>
                <h2 id="appointment-detail-title">
                  {selectedAppointment.contactName}
                </h2>
              </div>
              <button
                class="icon-button"
                type="button"
                aria-label="Cerrar el detalle del turno"
                disabled={detailBusy}
                onClick$={() => {
                  if (!detailBusy) selectedId.value = "";
                }}
              >
                <Icon name="x" size={20} />
              </button>
            </header>

            <div class="drawer-content appointment-detail-content">
              <div class="detail-badges">
                <span
                  class={`detail-badge status-${appointmentStatusTone(
                    selectedAppointment.status,
                    selectedAppointment.depositStatus,
                  )}`}
                >
                  {displayStatus(selectedAppointment)}
                </span>
                <span
                  class={{
                    "detail-badge": true,
                    "detail-badge-deposit": true,
                    confirmed:
                      selectedAppointment.depositStatus === "confirmed",
                    attention:
                      selectedAppointment.depositStatus === "proof_received",
                    expired: selectedAppointment.depositStatus === "expired",
                  }}
                >
                  {depositBadgeLabel}
                </span>
              </div>

              <section class="detail-section">
                <h3>Paciente</h3>
                <dl class="detail-grid">
                  <div>
                    <dt>Nombre</dt>
                    <dd>{selectedAppointment.contactName}</dd>
                  </div>
                  <div>
                    <dt>Teléfono</dt>
                    <dd>{selectedAppointment.contactPhone || "—"}</dd>
                  </div>
                </dl>
              </section>

              <section class="detail-section">
                <h3>Fecha y hora</h3>
                <dl class="detail-grid">
                  <div>
                    <dt>Comienza</dt>
                    <dd>
                      {formatBusinessDate(
                        new Date(selectedAppointment.startsAt),
                        { dateStyle: "full", timeStyle: "short" },
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Termina</dt>
                    <dd>
                      {formatBusinessDate(
                        new Date(selectedAppointment.endsAt),
                        {
                          timeStyle: "short",
                        },
                      )}
                    </dd>
                  </div>
                </dl>
              </section>

              <section class="detail-section">
                <h3>Atención</h3>
                <dl class="detail-grid">
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
                </dl>
              </section>

              <section class="detail-section">
                <h3>Seña y comprobante</h3>
                <dl class="detail-grid">
                  <div>
                    <dt>Estado de la seña</dt>
                    <dd>{depositBadgeLabel}</dd>
                  </div>
                  {selectedReview && (
                    <div>
                      <dt>Revisión</dt>
                      <dd>
                        {selectedReview.status === "pending"
                          ? "Comprobante esperando revisión"
                          : selectedReview.status === "confirmed"
                            ? "Comprobante aprobado"
                            : selectedReview.status === "rejected"
                              ? "Comprobante rechazado"
                              : "Le pedimos otro comprobante"}
                      </dd>
                    </div>
                  )}
                  {selectedAppointment.depositConfirmationActor ===
                    "automatic_system" && (
                    <div>
                      <dt>Confirmación de seña</dt>
                      <dd>Automática · comprobante disponible para revisión</dd>
                    </div>
                  )}
                </dl>
                {selectedProofMessageId ? (
                  <a
                    class="secondary-button detail-inline-action"
                    href={`/app/inbox?patient=${selectedAppointment.contactId}&message=${selectedProofMessageId}`}
                  >
                    <Icon name="file" size={17} />
                    {selectedAppointment.depositConfirmationActor ===
                    "automatic_system"
                      ? "Revisar comprobante"
                      : "Ver comprobante"}
                  </a>
                ) : (
                  <>
                    <p class="detail-hint">
                      No hay un comprobante asociado a este turno. Puede haber
                      llegado sin que la automatización lo asociara.
                    </p>
                    <a
                      class="secondary-button detail-inline-action"
                      href={`/app/inbox?patient=${selectedAppointment.contactId}`}
                    >
                      <Icon name="message" size={17} />
                      Ver conversación
                    </a>
                  </>
                )}
              </section>

              {selectedAppointment.internalNote && (
                <section class="detail-section">
                  <h3>Nota administrativa</h3>
                  <p class="detail-note">{selectedAppointment.internalNote}</p>
                </section>
              )}

              {selectedAppointmentActive && !state.isAdmin && (
                <p class="detail-hint" role="note">
                  Confirmar o rechazar una seña lo hace la persona
                  administradora.
                </p>
              )}
            </div>

            <footer class="detail-drawer-actions">
              {selectedAppointmentActive && !selectedAppointmentHasStarted && (
                <p
                  class="detail-disabled-hint"
                  id="detail-attendance-hint"
                  role="note"
                >
                  “Marcar atendido” y “No asistió” se habilitan después de la
                  hora del turno.
                </p>
              )}
              {canConfirmDeposit && (
                <button
                  class="primary-button detail-action-primary"
                  type="button"
                  disabled={detailBusy}
                  onClick$={() => confirmDeposit(selectedAppointment)}
                >
                  {confirmingDeposit.value
                    ? "Confirmando…"
                    : "Confirmar seña y turno"}
                </button>
              )}
              {canReviewProof && (
                <div class="detail-action-row">
                  <button
                    class="secondary-button"
                    type="button"
                    disabled={detailBusy}
                    onClick$={() =>
                      decideDepositProof(selectedAppointment, "more_requested")
                    }
                  >
                    {reviewingDeposit.value === "more_requested"
                      ? "Enviando…"
                      : "Pedir otro comprobante"}
                  </button>
                  <button
                    class="secondary-button"
                    type="button"
                    disabled={detailBusy}
                    onClick$={() =>
                      decideDepositProof(selectedAppointment, "rejected")
                    }
                  >
                    {reviewingDeposit.value === "rejected"
                      ? "Guardando…"
                      : "Rechazar comprobante"}
                  </button>
                </div>
              )}
              {selectedAppointmentActive && (
                <div class="detail-action-row">
                  <button
                    class="secondary-button"
                    type="button"
                    disabled={detailBusy}
                    onClick$={() => (rescheduling.value = true)}
                  >
                    Reprogramar
                  </button>
                  <button
                    class="secondary-button"
                    type="button"
                    disabled={detailBusy || !selectedAppointmentHasStarted}
                    aria-describedby={
                      selectedAppointmentHasStarted
                        ? undefined
                        : "detail-attendance-hint"
                    }
                    onClick$={() =>
                      changeStatus(selectedAppointment, "completed")
                    }
                  >
                    {savingStatus.value === "completed"
                      ? "Guardando…"
                      : "Marcar atendido"}
                  </button>
                  <button
                    class="secondary-button"
                    type="button"
                    disabled={detailBusy || !selectedAppointmentHasStarted}
                    aria-describedby={
                      selectedAppointmentHasStarted
                        ? undefined
                        : "detail-attendance-hint"
                    }
                    onClick$={() =>
                      changeStatus(selectedAppointment, "no_show")
                    }
                  >
                    {savingStatus.value === "no_show"
                      ? "Guardando…"
                      : "No asistió"}
                  </button>
                  <button
                    class="secondary-button danger-button"
                    type="button"
                    disabled={detailBusy}
                    onClick$={() =>
                      changeStatus(selectedAppointment, "cancelled")
                    }
                  >
                    {savingStatus.value === "cancelled"
                      ? "Guardando…"
                      : "Cancelar turno"}
                  </button>
                </div>
              )}
            </footer>
          </aside>
        </div>
      )}

      {convertingBlock && (
        <ConvertBlockDrawer
          block={convertingBlock}
          professionals={state.professionals}
          services={state.services}
          onClose$={() => (convertingBlockId.value = "")}
          onConverted$={(message) => {
            convertingBlockId.value = "";
            reloadVersion.value += 1;
            notice.value = message;
          }}
        />
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
