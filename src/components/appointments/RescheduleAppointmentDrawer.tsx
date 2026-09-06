import { ORTHODONTIC_VISIT_LABELS } from "~/lib/orthodontics";
import {
  component$,
  type QRL,
  useSignal,
  useStore,
  useVisibleTask$,
} from "@qwik.dev/core";
import type {
  AppointmentSlot,
  BookingDurationSettings,
  PatientCoverage,
} from "~/lib/inbox-types";
import { businessDateInput } from "~/lib/date-time";
import { getSupabaseClient } from "~/lib/supabase/client";
import {
  calendarBookingError,
  calendarProjectionNotice,
  verifyAppointmentCalendar,
} from "~/lib/calendar-projection";
import {
  loadAvailableSlots,
  type AppointmentListItem,
} from "~/lib/supabase/data";
import { Icon } from "../ui/Icon";

interface Props {
  appointment: AppointmentListItem;
  bookingDurations: BookingDurationSettings;
  onClose$: QRL<() => void>;
  onSaved$: QRL<(message: string) => void>;
}

function businessDate(value = new Date()): string {
  return businessDateInput(value);
}

export const RescheduleAppointmentDrawer = component$<Props>((props) => {
  const drawerRef = useSignal<HTMLElement>();
  const date = useSignal(businessDate(new Date(props.appointment.startsAt)));
  const selectedStartsAt = useSignal("");
  const coverage = useSignal<PatientCoverage | "">(
    props.appointment.contactCoverage ?? "",
  );
  const savingCoverage = useSignal(false);
  const saving = useSignal(false);
  const slotReloadVersion = useSignal(0);
  const error = useSignal("");
  const state = useStore<{
    slots: AppointmentSlot[];
    loading: boolean;
    loadError: boolean;
  }>({
    slots: [],
    loading: true,
    loadError: false,
  });

  // Move focus into the drawer when it opens and return it to the control that
  // opened it after the drawer closes.
  // eslint-disable-next-line qwik/no-use-visible-task
  useVisibleTask$(({ cleanup }) => {
    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : undefined;
    drawerRef.value?.focus();
    cleanup(() => {
      if (previousFocus && document.contains(previousFocus)) {
        previousFocus.focus();
      }
    });
  });

  useVisibleTask$(async ({ track, cleanup }) => {
    track(() => date.value);
    track(() => coverage.value);
    track(() => slotReloadVersion.value);
    let cancelled = false;
    cleanup(() => {
      cancelled = true;
    });
    selectedStartsAt.value = "";
    if (!coverage.value) {
      state.slots = [];
      state.loading = false;
      state.loadError = false;
      return;
    }
    state.loading = true;
    state.loadError = false;
    state.slots = [];
    try {
      const slots = await loadAvailableSlots(
        getSupabaseClient(),
        props.appointment.professionalId,
        date.value,
        coverage.value || undefined,
      );
      if (cancelled) return;
      state.slots = slots;
    } catch {
      if (cancelled) return;
      state.slots = [];
      state.loadError = true;
    } finally {
      if (!cancelled) state.loading = false;
    }
  });
  const busy = saving.value || savingCoverage.value;

  return (
    <div
      class="drawer-layer"
      role="presentation"
      onClick$={() => {
        if (!saving.value && !savingCoverage.value) props.onClose$();
      }}
    >
      <aside
        ref={drawerRef}
        class="drawer appointment-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="reschedule-title"
        aria-busy={busy}
        tabIndex={-1}
        stoppropagation:click
        onKeyDown$={(event) => {
          if (
            event.key === "Escape" &&
            !saving.value &&
            !savingCoverage.value
          ) {
            event.preventDefault();
            props.onClose$();
          }
        }}
      >
        <header class="drawer-header">
          <div>
            <span class="eyebrow">Agenda</span>
            <h2 id="reschedule-title">Reprogramar turno</h2>
          </div>
          <button
            class="icon-button"
            type="button"
            aria-label="Cerrar"
            disabled={busy}
            onClick$={() => {
              if (!saving.value && !savingCoverage.value) props.onClose$();
            }}
          >
            <Icon name="x" size={20} />
          </button>
        </header>
        <form
          class="appointment-form"
          preventdefault:submit
          onSubmit$={async () => {
            if (saving.value || savingCoverage.value) return;
            if (state.loading) {
              error.value = "Esperá a que termine la consulta de horarios.";
              return;
            }
            if (state.loadError) {
              error.value =
                "No pudimos validar la disponibilidad. Reintentá la consulta de horarios.";
              return;
            }
            if (!coverage.value || !selectedStartsAt.value) return;
            saving.value = true;
            error.value = "";
            try {
              const { error: rescheduleError } = await getSupabaseClient().rpc(
                "reschedule_service_appointment",
                {
                  p_appointment_id: props.appointment.id,
                  p_starts_at: selectedStartsAt.value,
                },
              );
              if (rescheduleError) {
                error.value = calendarBookingError(rescheduleError.message);
                return;
              }
              const calendarState = await verifyAppointmentCalendar(
                getSupabaseClient(),
                props.appointment.id,
              );
              await props.onSaved$(
                calendarState === "synced"
                  ? "Turno reprogramado en el sistema y Google Calendar."
                  : calendarProjectionNotice(calendarState),
              );
            } catch {
              error.value =
                "No pudimos confirmar si el turno se reprogramó. Cerrá y revisá la agenda antes de volver a intentar.";
            } finally {
              saving.value = false;
            }
          }}
        >
          <div class="patient-summary">
            <span class="agenda-avatar">
              {props.appointment.contactName
                .split(/\s+/)
                .slice(0, 2)
                .map((part) => part[0])
                .join("")}
            </span>
            <div>
              <span>Paciente</span>
              <strong>{props.appointment.contactName}</strong>
              <small>
                {coverage.value
                  ? coverage.value === "ioma"
                    ? `IOMA · ${props.bookingDurations.iomaMinutes} min`
                    : `Particular · ${props.bookingDurations.privateMinutes} min`
                  : "Cobertura pendiente"}
              </small>
            </div>
          </div>
          <p class="settings-note">
            El turno actual se conserva hasta que confirmes un nuevo horario.
          </p>
          {props.appointment.orthodonticVisitType && (
            <p class="settings-note">
              Ortodoncia ·{" "}
              {ORTHODONTIC_VISIT_LABELS[props.appointment.orthodonticVisitType]}
              .
              {props.appointment.orthodonticVisitType === "in_treatment"
                ? " Este turno sigue sin requerir seña al reprogramarlo."
                : " Se conserva el tipo de visita al reprogramar."}
            </p>
          )}

          {!coverage.value && (
            <fieldset class="coverage-picker coverage-picker-required">
              <legend>Elegí solo la cobertura para continuar</legend>
              <div class="coverage-options">
                {(["ioma", "particular"] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={coverage.value === value}
                    disabled={busy}
                    onClick$={async () => {
                      if (saving.value || savingCoverage.value) return;
                      savingCoverage.value = true;
                      selectedStartsAt.value = "";
                      error.value = "";
                      try {
                        const { error: coverageError } =
                          await getSupabaseClient()
                            .from("contacts")
                            .update({ coverage: value })
                            .eq("id", props.appointment.contactId);
                        if (coverageError) {
                          error.value = "No pudimos guardar la cobertura.";
                          return;
                        }
                        props.appointment.contactCoverage = value;
                        coverage.value = value;
                      } catch {
                        error.value = "No pudimos guardar la cobertura.";
                      } finally {
                        savingCoverage.value = false;
                      }
                    }}
                  >
                    {value === "ioma"
                      ? `IOMA · ${props.bookingDurations.iomaMinutes} min`
                      : `Particular · ${props.bookingDurations.privateMinutes} min`}
                  </button>
                ))}
              </div>
            </fieldset>
          )}
          <label class="form-field">
            <span>Nueva fecha</span>
            <div class="input-with-icon">
              <Icon name="calendar" size={18} />
              <input
                type="date"
                min={businessDate()}
                value={date.value}
                disabled={busy}
                onInput$={(_, element) => {
                  date.value = element.value;
                  selectedStartsAt.value = "";
                }}
              />
            </div>
          </label>
          <fieldset class="slot-picker">
            <legend>Nuevo horario</legend>
            {state.loadError ? (
              <>
                <p class="login-error" role="alert">
                  No pudimos consultar los horarios. El turno actual sigue sin
                  cambios.
                </p>
                <button
                  class="secondary-button small"
                  type="button"
                  onClick$={() => (slotReloadVersion.value += 1)}
                >
                  Reintentar horarios
                </button>
              </>
            ) : (
              <>
                <div>
                  {coverage.value &&
                    state.slots.map((slot) => (
                      <button
                        key={slot.startsAt}
                        type="button"
                        class={{
                          selected: selectedStartsAt.value === slot.startsAt,
                        }}
                        disabled={busy}
                        onClick$={() =>
                          (selectedStartsAt.value = slot.startsAt)
                        }
                      >
                        {slot.label}
                      </button>
                    ))}
                </div>
                <small>
                  {state.loading
                    ? "Consultando horarios…"
                    : !coverage.value
                      ? "Primero elegí la cobertura del paciente."
                      : state.slots.length
                        ? `${coverage.value === "ioma" ? props.bookingDurations.iomaMinutes : props.bookingDurations.privateMinutes} minutos`
                        : "No hay horarios disponibles para ese día."}
                </small>
              </>
            )}
          </fieldset>
          {error.value && (
            <p class="login-error" role="alert">
              {error.value}
            </p>
          )}
          <div class="drawer-form-actions">
            <button
              class="secondary-button"
              type="button"
              disabled={busy}
              onClick$={() => {
                if (!saving.value && !savingCoverage.value) props.onClose$();
              }}
            >
              Conservar turno
            </button>
            <button
              class="primary-button"
              type="submit"
              disabled={
                !coverage.value ||
                !selectedStartsAt.value ||
                state.loading ||
                state.loadError ||
                saving.value ||
                savingCoverage.value
              }
            >
              {saving.value ? "Guardando…" : "Confirmar cambio"}
            </button>
          </div>
        </form>
      </aside>
    </div>
  );
});
