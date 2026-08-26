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
  const date = useSignal(businessDate(new Date(props.appointment.startsAt)));
  const selectedStartsAt = useSignal("");
  const coverage = useSignal<PatientCoverage | "">(
    props.appointment.contactCoverage ?? "",
  );
  const savingCoverage = useSignal(false);
  const saving = useSignal(false);
  const error = useSignal("");
  const state = useStore<{ slots: AppointmentSlot[]; loading: boolean }>({
    slots: [],
    loading: true,
  });
  useVisibleTask$(async ({ track }) => {
    track(() => date.value);
    track(() => coverage.value);
    selectedStartsAt.value = "";
    if (!coverage.value) {
      state.slots = [];
      state.loading = false;
      return;
    }
    state.loading = true;
    try {
      state.slots = await loadAvailableSlots(
        getSupabaseClient(),
        props.appointment.professionalId,
        date.value,
        coverage.value || undefined,
      );
    } catch {
      state.slots = [];
    } finally {
      state.loading = false;
    }
  });

  return (
    <div class="drawer-layer" role="presentation" onClick$={props.onClose$}>
      <aside
        class="drawer appointment-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="reschedule-title"
        onClick$={(event) => event.stopPropagation()}
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
            onClick$={props.onClose$}
          >
            <Icon name="x" size={20} />
          </button>
        </header>
        <form
          class="appointment-form"
          preventdefault:submit
          onSubmit$={async () => {
            if (!coverage.value || !selectedStartsAt.value || saving.value)
              return;
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
                error.value = rescheduleError.message.includes(
                  "SLOT_UNAVAILABLE",
                )
                  ? "Ese horario acaba de ocuparse. Elegí otro disponible."
                  : "No pudimos reprogramar el turno.";
                return;
              }
              await props.onSaved$("Turno reprogramado.");
            } catch {
              error.value = "No pudimos reprogramar el turno.";
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
          {!coverage.value && (
            <fieldset class="coverage-picker coverage-picker-required">
              <legend>Elegí solo la cobertura para continuar</legend>
              <div class="coverage-options">
                {(["ioma", "particular"] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    disabled={savingCoverage.value}
                    onClick$={async () => {
                      savingCoverage.value = true;
                      const { error: coverageError } = await getSupabaseClient()
                        .from("contacts")
                        .update({ coverage: value })
                        .eq("id", props.appointment.contactId);
                      savingCoverage.value = false;
                      if (coverageError) {
                        error.value = "No pudimos guardar la cobertura.";
                        return;
                      }
                      props.appointment.contactCoverage = value;
                      coverage.value = value;
                      error.value = "";
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
                onInput$={(_, element) => (date.value = element.value)}
              />
            </div>
          </label>
          <fieldset class="slot-picker">
            <legend>Nuevo horario</legend>
            <div>
              {coverage.value &&
                state.slots.map((slot) => (
                  <button
                    key={slot.startsAt}
                    type="button"
                    class={{
                      selected: selectedStartsAt.value === slot.startsAt,
                    }}
                    onClick$={() => (selectedStartsAt.value = slot.startsAt)}
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
              onClick$={props.onClose$}
            >
              Conservar turno
            </button>
            <button
              class="primary-button"
              type="submit"
              disabled={
                !coverage.value || !selectedStartsAt.value || saving.value
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
