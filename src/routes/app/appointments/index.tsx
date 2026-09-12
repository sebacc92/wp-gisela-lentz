import { ORTHODONTIC_VISIT_LABELS } from "~/lib/orthodontics";
import {
  $,
  component$,
  useSignal,
  useStore,
  useVisibleTask$,
} from "@qwik.dev/core";
import { useLocation, type DocumentHead } from "@qwik.dev/router";
import "./agenda-print.css";
import "./agenda.css";
import { AppNavigation } from "~/components/app/AppNavigation";
import { GoogleCalendarStatusBlock } from "~/components/app/GoogleCalendarStatusBlock";
import { ManualHelpLink } from "~/components/app/ManualHelpLink";
import { ConvertBlockDrawer } from "~/components/appointments/ConvertBlockDrawer";
import { CalendarConflictModal } from "~/components/appointments/CalendarConflictModal";
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
import type {
  BookingDurationSettings,
  DepositStatus,
  PatientCoverage,
} from "~/lib/inbox-types";
import {
  activeAgendaFilterCount,
  matchesAgendaFilters,
  type AgendaFilters,
} from "~/lib/agenda-filters";
import {
  agendaVisibleDates,
  isAgendaViewMode,
  monthGrid,
  shiftAgendaDate,
  weekDays as weekDaysFor,
  type AgendaViewMode,
} from "~/lib/agenda-view";
import {
  confirmDepositManually,
  describeDepositConfirmationError,
  reviewDepositProof,
  type DepositReviewDecision,
} from "~/lib/deposit-review";
import { parseCalendarPatientTitle } from "~/lib/calendar-patient-title";
import { getSupabaseClient } from "~/lib/supabase/client";
import {
  calendarBookingError,
  calendarProjectionNotice,
  readAppointmentCalendar,
  type CalendarProjectionState,
} from "~/lib/calendar-projection";
import {
  loadAppointments,
  loadBookingDurationSettings,
  loadCalendarBlocks,
  loadCalendarConflicts,
  loadDepositProofReviews,
  loadProfessionals,
  loadServices,
  type AppointmentListItem,
  type CalendarBlock,
  type CalendarConflict,
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

function dateRange(value: string): { from: string; to: string } {
  const { from, to } = getBusinessCalendarDayRange(value);
  return { from: from.toISOString(), to: to.toISOString() };
}

/** Rango a consultar según la vista elegida, ya en instantes. */
function viewRange(
  mode: AgendaViewMode,
  value: string,
): { from: string; to: string } {
  const dates = agendaVisibleDates(mode, value);
  return {
    from: getBusinessCalendarDayRange(dates.from).from.toISOString(),
    to: getBusinessCalendarDayRange(dates.to).to.toISOString(),
  };
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
  const viewMode = useSignal<AgendaViewMode>(
    isAgendaViewMode(location.url.searchParams.get("view"))
      ? (location.url.searchParams.get("view") as AgendaViewMode)
      : "day",
  );
  const draggingId = useSignal("");
  const dragOverDate = useSignal("");
  const rescheduleTargetDate = useSignal("");
  const coverageFilter = useSignal<PatientCoverage | "">("");
  const serviceFilter = useSignal("");
  const professionalFilter = useSignal("");
  const filtersOpen = useSignal(false);
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
  const reviewingConflictId = useSignal("");
  const detailRef = useSignal<HTMLElement>();
  const detailCalendar = useSignal<CalendarProjectionState | "loading">(
    "loading",
  );
  const reloadVersion = useSignal(0);
  const notice = useSignal("");
  const printState = useStore<{
    appointments: AppointmentListItem[];
    date: string;
    generatedAt: string;
    preparing: "" | "today" | "tomorrow" | "selected";
    request: number;
  }>({
    appointments: [],
    date: businessDateInput(),
    generatedAt: "",
    preparing: "",
    request: 0,
  });
  const state = useStore<{
    appointments: AppointmentListItem[];
    professionals: ProfessionalOption[];
    services: ServiceOption[];
    bookingDurations: BookingDurationSettings;
    blocks: CalendarBlock[];
    conflicts: CalendarConflict[];
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
    conflicts: [],
    depositReviews: [],
    isAdmin: false,
    loading: true,
    error: false,
  });

  useVisibleTask$(async ({ track, cleanup }) => {
    track(() => selectedDate.value);
    track(() => viewMode.value);
    track(() => futureDepositMode.value);
    track(() => reloadVersion.value);
    let current = true;
    cleanup(() => {
      current = false;
    });
    state.loading = true;
    state.error = false;
    try {
      const range = viewRange(viewMode.value, selectedDate.value);
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
      if (!current) return;
      state.appointments = appointments;
      state.professionals = professionals;
      state.services = services;
      state.bookingDurations = bookingDurations;
      state.blocks = blocks;
      // Los conflictos son un aviso, no parte de la agenda: si la consulta
      // falla, la pantalla sigue sirviendo y simplemente no los muestra.
      state.conflicts = await loadCalendarConflicts(client).catch(
        (): CalendarConflict[] => [],
      );
      const depositReviews = await loadDepositProofReviews(
        client,
        appointments.map((appointment) => appointment.id),
      ).catch((): DepositProofReview[] => []);
      if (!current) return;
      state.depositReviews = depositReviews;
      const { data: user } = await client.auth.getUser();
      if (user.user) {
        const { data: profile } = await client
          .from("profiles")
          .select("role")
          .eq("id", user.user.id)
          .maybeSingle();
        if (current) state.isAdmin = profile?.role === "ADMIN";
      }
    } catch {
      if (current) state.error = true;
    } finally {
      if (current) state.loading = false;
    }
  });

  useVisibleTask$(({ cleanup }) => {
    const client = getSupabaseClient();
    let calendarRefresh: number | undefined;
    const queueCalendarRefresh = () => {
      if (document.hidden) return;
      window.clearTimeout(calendarRefresh);
      calendarRefresh = window.setTimeout(() => {
        reloadVersion.value += 1;
      }, 200);
    };
    const channel = client
      .channel("agenda-realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "appointments" },
        () => (reloadVersion.value += 1),
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          // La señal no contiene nombres ni identificadores de Google.
          table: "calendar_availability_updates",
        },
        queueCalendarRefresh,
      )
      .subscribe();
    const refresh = () => {
      if (!document.hidden) reloadVersion.value += 1;
    };
    const interval = window.setInterval(refresh, 60_000);
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("calendar-synchronized", refresh);
    cleanup(() => {
      window.clearTimeout(calendarRefresh);
      void client.removeChannel(channel);
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("calendar-synchronized", refresh);
    });
  });

  // El detalle es un diálogo modal: al abrirlo recibe el foco y al cerrarlo lo
  // devuelve a la fila que lo abrió, para que el teclado no quede perdido.
  // eslint-disable-next-line qwik/no-use-visible-task
  useVisibleTask$(async ({ track, cleanup }) => {
    const id = track(() => selectedId.value);
    track(() => reloadVersion.value);
    if (!id) return;
    if (
      state.appointments.find((appointment) => appointment.id === id)
        ?.googleCalendarImported
    ) {
      detailCalendar.value = "unavailable";
      return;
    }
    let current = true;
    cleanup(() => {
      current = false;
    });
    detailCalendar.value = "loading";
    const result = await readAppointmentCalendar(getSupabaseClient(), id);
    if (current) detailCalendar.value = result;
  });

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

  const preparePrint = $(async (target: "today" | "tomorrow" | "selected") => {
    if (printState.preparing) return;

    printState.preparing = target;
    const today = businessDateInput();
    const targetDate =
      target === "today"
        ? today
        : target === "tomorrow"
          ? shiftDate(today, 1)
          : selectedDate.value;
    const range = dateRange(targetDate);

    try {
      const appointments = await loadAppointments(
        getSupabaseClient(),
        range.from,
        range.to,
      );
      // La hoja del día lista a quién se espera atender: un turno cancelado
      // o con la pre-reserva vencida ya no ocupa lugar.
      printState.appointments = appointments.filter(
        (appointment) =>
          appointment.status !== "cancelled" &&
          appointment.depositStatus !== "expired",
      );
      printState.date = targetDate;
      printState.generatedAt = new Date().toISOString();
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
      if (appointment.googleCalendarImported && status === "cancelled") {
        notice.value = calendarBookingError(
          "CALENDAR_IMPORTED_APPOINTMENT_READ_ONLY",
        );
        return;
      }
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
          notice.value = error.message.includes(
            "CALENDAR_IMPORTED_APPOINTMENT_READ_ONLY",
          )
            ? calendarBookingError(error.message)
            : "No pudimos cambiar el estado. No se hicieron cambios; intentá de nuevo.";
          return;
        }
        selectedId.value = "";
        reloadVersion.value += 1;
        notice.value = statusSuccessMessage(appointment.contactName, status);
      } catch {
        notice.value =
          "No pudimos comprobar si cambió el estado. Actualizá la agenda antes de volver a intentar.";
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
        `¿Confirmar la seña y el turno?\n\nPaciente: ${appointment.contactName}\nFecha: ${dateAndTime}\nServicio: ${appointment.serviceName}\n\nQueda registrado como tu decisión: el sistema no verifica la transferencia con el banco. El aviso por WhatsApp se envía si Google Calendar y la ventana de atención lo permiten.`,
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
      notice.value = result.calendarState
        ? calendarProjectionNotice(result.calendarState)
        : result.alreadyConfirmed
          ? `El turno de ${appointment.contactName} ya estaba confirmado.`
          : result.notified
            ? `Seña confirmada. Avisamos a ${appointment.contactName} por WhatsApp.`
            : "Seña confirmada. El turno quedó guardado, pero no pudimos enviar el aviso por WhatsApp.";
    } catch {
      notice.value =
        "No pudimos comprobar si la seña se confirmó. Actualizá la agenda antes de volver a intentar.";
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

  const agendaFilters: AgendaFilters = {
    query: query.value,
    status: statusFilter.value,
    deposit: depositFilter.value,
    coverage: coverageFilter.value,
    serviceId: serviceFilter.value,
    professionalId: professionalFilter.value,
  };
  const activeFilterCount = activeAgendaFilterCount(agendaFilters);
  const visibleAppointments = state.appointments.filter((appointment) =>
    matchesAgendaFilters(appointment, agendaFilters),
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
        ? "Seña no requerida"
        : selectedAppointment.depositStatus === "expired"
          ? "Seña vencida"
          : selectedAppointment.depositStatus === "proof_received"
            ? "Comprobante recibido"
            : "Seña pendiente";
  const reviewingConflict = state.conflicts.find(
    (conflict) => conflict.id === reviewingConflictId.value,
  );
  const convertingBlock = state.blocks.find(
    (block) => block.googleEventId === convertingBlockId.value,
  );
  // Los eventos que Gisela escribe a mano en Google llegan como bloqueos. Los
  // que parecen un paciente van primero: son los que falta pasar a la agenda.
  const blocksByPriority = state.blocks
    .map((block) => ({
      block,
      hints: parseCalendarPatientTitle(block.summary),
    }))
    .sort(
      (first, second) =>
        Number(second.hints.isPatientCandidate) -
        Number(first.hints.isPatientCandidate),
    );
  const importableBlockCount = blocksByPriority.filter(
    ({ hints }) => hints.isPatientCandidate,
  ).length;
  const detailBusy =
    Boolean(savingStatus.value) ||
    confirmingDeposit.value ||
    Boolean(reviewingDeposit.value);
  const isToday = selectedDate.value === businessDateInput();
  const weekDays = weekDaysFor(selectedDate.value);

  // Agrupación por día para las vistas de semana y mes. La clave es la fecha
  // calendario del consultorio, no la del navegador.
  const appointmentsByDate = new Map<string, AppointmentListItem[]>();
  for (const appointment of visibleAppointments) {
    const key = businessDateInput(new Date(appointment.startsAt));
    const bucket = appointmentsByDate.get(key);
    if (bucket) bucket.push(appointment);
    else appointmentsByDate.set(key, [appointment]);
  }
  const monthDays =
    viewMode.value === "month" ? monthGrid(selectedDate.value) : [];
  const activeDayAppointments = state.appointments.filter(
    (appointment) =>
      appointment.status !== "cancelled" &&
      appointment.depositStatus !== "expired",
  );
  const pendingDayAppointments = activeDayAppointments.filter(
    (appointment) =>
      appointment.depositStatus === "pending" ||
      appointment.depositStatus === "proof_received",
  );
  const printCoverageSummary = (() => {
    const ioma = printState.appointments.filter(
      (appointment) => appointment.coverage === "ioma",
    ).length;
    const particular = printState.appointments.filter(
      (appointment) => appointment.coverage === "particular",
    ).length;
    const parts: string[] = [];
    if (ioma > 0) parts.push(`${ioma} IOMA`);
    if (particular > 0) parts.push(`${particular} particular`);
    return parts.join(" · ");
  })();
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
            <details class="agenda-print-menu">
              <summary class="secondary-button">
                <Icon name="printer" size={17} /> Imprimir
              </summary>
              <div class="agenda-print-options">
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
                  class="secondary-button agenda-print-action"
                  type="button"
                  disabled={Boolean(printState.preparing)}
                  onClick$={() => preparePrint("selected")}
                >
                  <Icon name="printer" size={17} />
                  {printState.preparing === "selected"
                    ? "Preparando…"
                    : "Imprimir el día que estoy viendo"}
                </button>
                {/* No generamos el archivo: abrimos el mismo diálogo, donde
                    "Guardar como PDF" produce la hoja ya maquetada. */}
                <p class="agenda-print-note">
                  Para guardarlo como PDF, elegí “Guardar como PDF” como destino
                  en el diálogo de impresión.
                </p>
              </div>
            </details>
            <button
              class="primary-button"
              type="button"
              onClick$={() => (creating.value = true)}
            >
              <Icon name="plus" size={17} /> Nuevo turno
            </button>
          </div>
        </header>

        <div class="agenda-layout">
          <div class="agenda-main">
            {!futureDepositMode.value && viewMode.value === "day" && (
              <nav class="agenda-week" aria-label="Días de la semana">
                {weekDays.map((date) => (
                  <button
                    key={date}
                    type="button"
                    class={{
                      "agenda-week-day": true,
                      selected: date === selectedDate.value,
                      today: date === businessDateInput(),
                    }}
                    aria-label={formatSelectedDate(date)}
                    aria-pressed={date === selectedDate.value}
                    aria-current={
                      date === businessDateInput() ? "date" : undefined
                    }
                    onClick$={() => {
                      selectedDate.value = date;
                      selectedId.value = "";
                    }}
                  >
                    <span>
                      {new Intl.DateTimeFormat("es-AR", {
                        weekday: "short",
                        timeZone: "UTC",
                      })
                        .format(new Date(`${date}T12:00:00Z`))
                        .replace(".", "")}
                    </span>
                    <strong>{Number(date.slice(-2))}</strong>
                    <small>
                      {date === businessDateInput() ? "Hoy" : "\u00a0"}
                    </small>
                  </button>
                ))}
              </nav>
            )}

            <div class="section-toolbar agenda-toolbar">
              <div class="agenda-date-nav" aria-label="Cambiar día">
                <button
                  class="secondary-button small"
                  type="button"
                  aria-label={
                    viewMode.value === "month"
                      ? "Mes anterior"
                      : viewMode.value === "week"
                        ? "Semana anterior"
                        : "Día anterior"
                  }
                  onClick$={() => {
                    futureDepositMode.value = false;
                    selectedDate.value = shiftAgendaDate(
                      viewMode.value,
                      selectedDate.value,
                      -1,
                    );
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
                  aria-label={
                    viewMode.value === "month"
                      ? "Mes siguiente"
                      : viewMode.value === "week"
                        ? "Semana siguiente"
                        : "Día siguiente"
                  }
                  onClick$={() => {
                    futureDepositMode.value = false;
                    selectedDate.value = shiftAgendaDate(
                      viewMode.value,
                      selectedDate.value,
                      1,
                    );
                  }}
                >
                  →
                </button>
                <button
                  class={{
                    "filter-pill": true,
                    active: isToday && !futureDepositMode.value,
                  }}
                  type="button"
                  onClick$={() => {
                    futureDepositMode.value = false;
                    selectedDate.value = businessDateInput();
                  }}
                >
                  Hoy
                </button>
                <button
                  class="filter-pill"
                  type="button"
                  onClick$={() => {
                    futureDepositMode.value = false;
                    selectedDate.value = shiftDate(businessDateInput(), 1);
                  }}
                >
                  Mañana
                </button>
              </div>

              <div
                class="agenda-view-switch"
                role="group"
                aria-label="Cómo ver la agenda"
              >
                {(["day", "week", "month"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    class={{
                      "filter-pill": true,
                      active:
                        viewMode.value === mode && !futureDepositMode.value,
                    }}
                    aria-pressed={
                      viewMode.value === mode && !futureDepositMode.value
                    }
                    onClick$={() => {
                      futureDepositMode.value = false;
                      viewMode.value = mode;
                      selectedId.value = "";
                    }}
                  >
                    {mode === "day"
                      ? "Día"
                      : mode === "week"
                        ? "Semana"
                        : "Mes"}
                  </button>
                ))}
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
                    <option value="scheduled">
                      Esperando seña o comprobante
                    </option>
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

              <button
                class={{ "filter-pill": true, active: filtersOpen.value }}
                type="button"
                aria-expanded={filtersOpen.value}
                aria-controls="agenda-filter-panel"
                onClick$={() => (filtersOpen.value = !filtersOpen.value)}
              >
                Más filtros
                {activeFilterCount > 0 ? ` (${activeFilterCount})` : ""}
              </button>
            </div>

            {filtersOpen.value && (
              <div
                id="agenda-filter-panel"
                class="agenda-filter-panel"
                role="group"
                aria-label="Filtros combinados"
              >
                <label class="agenda-status-filter">
                  <span>Cobertura</span>
                  <div class="select-wrap">
                    <select
                      value={coverageFilter.value}
                      onChange$={(_, element) =>
                        (coverageFilter.value = element.value as
                          | PatientCoverage
                          | "")
                      }
                    >
                      <option value="">Todas</option>
                      <option value="ioma">IOMA</option>
                      <option value="particular">Particular</option>
                    </select>
                    <Icon name="chevron-down" size={17} />
                  </div>
                </label>

                <label class="agenda-status-filter">
                  <span>Seña</span>
                  <div class="select-wrap">
                    <select
                      value={depositFilter.value}
                      onChange$={(_, element) => {
                        depositFilter.value = element.value as
                          | DepositStatus
                          | "";
                        if (!element.value) futureDepositMode.value = false;
                      }}
                    >
                      <option value="">Cualquiera</option>
                      <option value="pending">Esperando seña</option>
                      <option value="proof_received">
                        Comprobante recibido
                      </option>
                      <option value="confirmed">Confirmada</option>
                      <option value="not_required">No requerida</option>
                    </select>
                    <Icon name="chevron-down" size={17} />
                  </div>
                </label>

                <label class="agenda-status-filter">
                  <span>Motivo</span>
                  <div class="select-wrap">
                    <select
                      value={serviceFilter.value}
                      onChange$={(_, element) =>
                        (serviceFilter.value = element.value)
                      }
                    >
                      <option value="">Todos</option>
                      {state.services.map((service) => (
                        <option key={service.id} value={service.id}>
                          {service.name}
                        </option>
                      ))}
                    </select>
                    <Icon name="chevron-down" size={17} />
                  </div>
                </label>

                {/* Hoy atiende sólo Gisela; el filtro aparece si algún día se
                suman más profesionales. */}
                {state.professionals.length > 1 && (
                  <label class="agenda-status-filter">
                    <span>Profesional</span>
                    <div class="select-wrap">
                      <select
                        value={professionalFilter.value}
                        onChange$={(_, element) =>
                          (professionalFilter.value = element.value)
                        }
                      >
                        <option value="">Todos</option>
                        {state.professionals.map((professional) => (
                          <option key={professional.id} value={professional.id}>
                            {professional.name}
                          </option>
                        ))}
                      </select>
                      <Icon name="chevron-down" size={17} />
                    </div>
                  </label>
                )}

                <button
                  class="secondary-button small"
                  type="button"
                  disabled={activeFilterCount === 0}
                  onClick$={() => {
                    query.value = "";
                    statusFilter.value = "";
                    depositFilter.value = "";
                    coverageFilter.value = "";
                    serviceFilter.value = "";
                    professionalFilter.value = "";
                    futureDepositMode.value = false;
                  }}
                >
                  Limpiar filtros
                </button>
              </div>
            )}

            {viewMode.value === "month" &&
              !futureDepositMode.value &&
              !state.loading &&
              !state.error && (
                <div
                  class="agenda-month"
                  role="grid"
                  aria-label="Agenda del mes"
                >
                  <p class="agenda-month-hint">
                    Tocá un turno para abrirlo o arrastralo a otro día para
                    reprogramarlo. El horario se elige entre los disponibles y
                    se confirma antes de mover nada.
                  </p>
                  <div class="agenda-month-head" role="row">
                    {["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"].map(
                      (label) => (
                        <span key={label} role="columnheader">
                          {label}
                        </span>
                      ),
                    )}
                  </div>
                  <div class="agenda-month-grid" role="rowgroup">
                    {monthDays.map((day) => {
                      const dayAppointments =
                        appointmentsByDate.get(day.date) ?? [];
                      const isTodayCell = day.date === businessDateInput();
                      return (
                        <div
                          key={day.date}
                          role="gridcell"
                          class={{
                            "agenda-month-day": true,
                            outside: !day.inMonth,
                            today: isTodayCell,
                            selected: day.date === selectedDate.value,
                            "drop-target": dragOverDate.value === day.date,
                          }}
                          aria-current={isTodayCell ? "date" : undefined}
                          preventdefault:dragover
                          onDragOver$={() => {
                            if (draggingId.value) dragOverDate.value = day.date;
                          }}
                          onDragLeave$={() => {
                            if (dragOverDate.value === day.date) {
                              dragOverDate.value = "";
                            }
                          }}
                          preventdefault:drop
                          onDrop$={() => {
                            const appointmentId = draggingId.value;
                            draggingId.value = "";
                            dragOverDate.value = "";
                            if (!appointmentId) return;
                            const dragged = state.appointments.find(
                              (item) => item.id === appointmentId,
                            );
                            if (!dragged) return;
                            // Soltar no reprograma: abre la reprogramación con el
                            // día elegido para que el horario salga de la
                            // disponibilidad real y quede confirmado a mano.
                            if (
                              businessDateInput(new Date(dragged.startsAt)) ===
                              day.date
                            ) {
                              return;
                            }
                            selectedId.value = appointmentId;
                            rescheduleTargetDate.value = day.date;
                            rescheduling.value = true;
                          }}
                        >
                          <button
                            class="agenda-month-daynumber"
                            type="button"
                            aria-label={`${formatSelectedDate(day.date)}: ${
                              dayAppointments.length
                            } ${dayAppointments.length === 1 ? "turno" : "turnos"}`}
                            onClick$={() => {
                              selectedDate.value = day.date;
                              viewMode.value = "day";
                              selectedId.value = "";
                            }}
                          >
                            {Number(day.date.slice(-2))}
                          </button>
                          {dayAppointments.length > 0 && (
                            <span class="agenda-month-items">
                              {dayAppointments
                                .slice(0, 3)
                                .map((appointment) => {
                                  const movable = !finalStatuses.has(
                                    appointment.status,
                                  );
                                  return (
                                    <button
                                      key={appointment.id}
                                      type="button"
                                      class={{
                                        "agenda-month-item": true,
                                        [`status-${statusTone(appointment)}`]: true,
                                        dragging:
                                          draggingId.value === appointment.id,
                                      }}
                                      draggable={movable}
                                      title={`${appointment.contactName} · ${appointment.serviceName}`}
                                      onDragStart$={() => {
                                        if (movable)
                                          draggingId.value = appointment.id;
                                      }}
                                      onDragEnd$={() => {
                                        draggingId.value = "";
                                        dragOverDate.value = "";
                                      }}
                                      onClick$={() => {
                                        selectedDate.value = day.date;
                                        selectedId.value = appointment.id;
                                      }}
                                    >
                                      {formatBusinessDate(
                                        new Date(appointment.startsAt),
                                        {
                                          hour: "2-digit",
                                          minute: "2-digit",
                                          hour12: false,
                                        },
                                      )}{" "}
                                      {appointment.contactName.split(/\s+/)[0]}
                                    </button>
                                  );
                                })}
                              {dayAppointments.length > 3 && (
                                <button
                                  class="agenda-month-more"
                                  type="button"
                                  onClick$={() => {
                                    selectedDate.value = day.date;
                                    viewMode.value = "day";
                                    selectedId.value = "";
                                  }}
                                >
                                  +{dayAppointments.length - 3} más
                                </button>
                              )}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

            <div
              class="agenda-list"
              aria-busy={state.loading}
              hidden={
                viewMode.value === "month" &&
                !futureDepositMode.value &&
                !state.loading &&
                !state.error
              }
            >
              <div class="agenda-label">
                <span>
                  {visibleAppointments.length}{" "}
                  {visibleAppointments.length === 1 ? "turno" : "turnos"}
                </span>
                <i />
              </div>
              {state.loading ? (
                <div class="section-empty" role="status">
                  <span class="small-spinner" aria-hidden="true" />
                  <p>Cargando turnos…</p>
                </div>
              ) : state.error ? (
                <div class="section-empty" role="alert">
                  <Icon name="alert" size={23} />
                  <p>No pudimos cargar la agenda.</p>
                  <button
                    type="button"
                    onClick$={() => (reloadVersion.value += 1)}
                  >
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
                      coverageFilter.value = "";
                      serviceFilter.value = "";
                      professionalFilter.value = "";
                      futureDepositMode.value = false;
                    }}
                  >
                    {viewMode.value === "week"
                      ? "Ver todos los turnos de la semana"
                      : viewMode.value === "month"
                        ? "Ver todos los turnos del mes"
                        : "Ver todos los turnos del día"}
                  </button>
                </div>
              ) : visibleAppointments.length === 0 ? (
                <div class="section-empty">
                  <Icon name="calendar" size={25} />
                  <p>
                    {viewMode.value === "week"
                      ? "No hay turnos en esta semana."
                      : viewMode.value === "month"
                        ? "No hay turnos en este mes."
                        : "No hay turnos para este día."}
                  </p>
                  <button
                    type="button"
                    onClick$={() => (creating.value = true)}
                  >
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
                      <time dateTime={appointment.startsAt}>
                        {(futureDepositMode.value ||
                          viewMode.value !== "day") && (
                          <small>
                            {formatBusinessDate(
                              new Date(appointment.startsAt),
                              {
                                weekday: "short",
                                day: "numeric",
                                month: "short",
                              },
                            )}
                          </small>
                        )}
                        <strong>
                          {formatBusinessDate(new Date(appointment.startsAt), {
                            hour: "2-digit",
                            minute: "2-digit",
                            hour12: false,
                          })}
                        </strong>
                        <small class="agenda-end-time">
                          hasta{" "}
                          {formatBusinessDate(new Date(appointment.endsAt), {
                            timeStyle: "short",
                          })}
                        </small>
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
                        <span class="agenda-service">
                          {appointment.serviceName}
                        </span>
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
          </div>
          <div class="agenda-aside">
            <GoogleCalendarStatusBlock
              variant="agenda"
              conflictsHandledInPage={state.conflicts.length > 0}
            />

            <div
              class="agenda-day-summary"
              aria-label={
                futureDepositMode.value
                  ? "Resumen de próximos turnos"
                  : "Resumen del día"
              }
            >
              {!state.loading && !state.error && (
                <>
                  <span>
                    <strong>{activeDayAppointments.length}</strong> turnos
                    activos
                  </span>
                  <span>
                    <strong>{pendingDayAppointments.length}</strong> señas
                    pendientes
                  </span>
                  <span>
                    <strong>{state.blocks.length}</strong> bloqueos de Google
                  </span>
                  <button
                    type="button"
                    onClick$={() => (reloadVersion.value += 1)}
                  >
                    Actualizar agenda
                  </button>
                </>
              )}
            </div>

            {!state.loading && !state.error && state.blocks.length > 0 && (
              <details
                class="agenda-blocks"
                aria-label="Bloqueos de Google Calendar"
                open={importableBlockCount > 0}
              >
                <summary>
                  <h2>
                    Google Calendar · {state.blocks.length}{" "}
                    {state.blocks.length === 1
                      ? "horario ocupado"
                      : "horarios ocupados"}
                    {importableBlockCount > 0 && (
                      <>
                        {" · "}
                        {importableBlockCount}{" "}
                        {importableBlockCount === 1
                          ? "parece un turno"
                          : "parecen turnos"}
                      </>
                    )}
                  </h2>
                </summary>
                <ul>
                  {blocksByPriority.map(({ block, hints }) => (
                    <li key={block.googleEventId}>
                      <strong>
                        {futureDepositMode.value && (
                          <small>
                            {formatBusinessDate(new Date(block.startsAt), {
                              day: "numeric",
                              month: "short",
                            })}
                            {" · "}
                          </small>
                        )}
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
                      {hints.isPatientCandidate && (
                        <em class="agenda-block-patient">
                          Parece el turno de {hints.name ?? "un paciente"}
                        </em>
                      )}
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
                  Vienen de un evento creado a mano en Google Calendar. Ocupan
                  el horario, pero no son turnos de pacientes hasta que se
                  convierten. Convertirlos no modifica nada en Google.
                </small>
              </details>
            )}

            {state.conflicts.length > 0 && !state.loading && (
              <section
                class="agenda-conflicts"
                aria-labelledby="agenda-conflicts-title"
              >
                <header>
                  <Icon name="alert" size={19} />
                  <div>
                    <strong id="agenda-conflicts-title">
                      {state.conflicts.length === 1
                        ? "Hay 1 cambio de Google Calendar para decidir"
                        : `Hay ${state.conflicts.length} cambios de Google Calendar para decidir`}
                    </strong>
                    <small>
                      Alguien movió, borró o editó estos turnos en Google. La
                      agenda no cambió sola.
                    </small>
                  </div>
                </header>
                <ul>
                  {state.conflicts.map((conflict) => (
                    <li key={conflict.id}>
                      <span>
                        <strong>{conflict.contactName}</strong>
                        <small>
                          {conflict.kind === "cancellation_requested"
                            ? "Se borró el evento en Google"
                            : conflict.kind === "metadata_changed"
                              ? "Cambió el texto del evento"
                              : "Se movió el turno en Google"}
                        </small>
                      </span>
                      <button
                        class="secondary-button small"
                        type="button"
                        onClick$={() =>
                          (reviewingConflictId.value = conflict.id)
                        }
                      >
                        Comparar y decidir
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
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
              {printCoverageSummary ? ` · ${printCoverageSummary}` : ""}
            </span>
            {printState.generatedAt && (
              <span>
                Impreso el{" "}
                {formatBusinessDate(new Date(printState.generatedAt), {
                  dateStyle: "short",
                  timeStyle: "short",
                })}
              </span>
            )}
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
                  {selectedAppointment.managedByName && (
                    <div>
                      <dt>Turno gestionado por</dt>
                      <dd>{selectedAppointment.managedByName}</dd>
                    </div>
                  )}
                  <div>
                    <dt>
                      {selectedAppointment.managedByName
                        ? "Teléfono de contacto"
                        : "Teléfono"}
                    </dt>
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

              {selectedAppointment.googleCalendarImported ? (
                <section class="detail-section">
                  <h3>Google Calendar</h3>
                  <p class="detail-hint">
                    Creado en Google Calendar. Para cambiar el horario o
                    cancelarlo, hacelo desde Google Calendar.
                  </p>
                </section>
              ) : (
                selectedAppointmentActive && (
                  <section class="detail-section" aria-live="polite">
                    <h3>Google Calendar</h3>
                    <p class="detail-hint">
                      {detailCalendar.value === "loading"
                        ? "Comprobando este turno…"
                        : detailCalendar.value === "synced"
                          ? "Este turno está guardado en Google Calendar."
                          : detailCalendar.value === "conflict"
                            ? "Hay un conflicto de horario. Revisá Google Calendar antes de confirmar este turno al paciente."
                            : "La reserva está en el sistema, pero su sincronización con Google todavía no está verificada."}
                    </p>
                  </section>
                )
              )}

              <section class="detail-section">
                <h3>Atención</h3>
                <dl class="detail-grid">
                  <div>
                    <dt>Servicio</dt>
                    <dd>{selectedAppointment.serviceName}</dd>
                  </div>
                  {selectedAppointment.orthodonticVisitType && (
                    <div>
                      <dt>Visita de ortodoncia</dt>
                      <dd>
                        {
                          ORTHODONTIC_VISIT_LABELS[
                            selectedAppointment.orthodonticVisitType
                          ]
                        }
                      </dd>
                    </div>
                  )}
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
                    <dd>
                      {depositBadgeLabel}
                      {selectedAppointment.depositStatus === "not_required" &&
                      selectedAppointment.orthodonticVisitType ===
                        "in_treatment"
                        ? " · en tratamiento con Gisela"
                        : ""}
                    </dd>
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
                  {!selectedAppointment.googleCalendarImported && (
                    <button
                      class="secondary-button"
                      type="button"
                      disabled={detailBusy}
                      onClick$={() => (rescheduling.value = true)}
                    >
                      Reprogramar
                    </button>
                  )}
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
                  {!selectedAppointment.googleCalendarImported && (
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
                  )}
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

      {reviewingConflict && (
        <CalendarConflictModal
          conflict={reviewingConflict}
          isAdmin={state.isAdmin}
          onClose$={() => (reviewingConflictId.value = "")}
          onResolved$={(message) => {
            reviewingConflictId.value = "";
            notice.value = message;
            reloadVersion.value += 1;
          }}
        />
      )}

      {rescheduling.value &&
        selectedAppointment &&
        !selectedAppointment.googleCalendarImported && (
          <RescheduleAppointmentDrawer
            appointment={selectedAppointment}
            bookingDurations={state.bookingDurations}
            initialDate={rescheduleTargetDate.value || undefined}
            onClose$={() => {
              rescheduling.value = false;
              rescheduleTargetDate.value = "";
            }}
            onSaved$={(message) => {
              rescheduling.value = false;
              rescheduleTargetDate.value = "";
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
