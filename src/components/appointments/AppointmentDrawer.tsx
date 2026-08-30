import {
  component$,
  type QRL,
  useSignal,
  useStore,
  useVisibleTask$,
} from "@qwik.dev/core";
import { businessDateInput } from "~/lib/date-time";
import type {
  AppointmentSlot,
  BookingDurationSettings,
  Conversation,
  PatientCoverage,
  ProfessionalOption,
  ServiceOption,
} from "~/lib/inbox-types";
import { getSupabaseClient } from "~/lib/supabase/client";
import { loadAvailableSlots } from "~/lib/supabase/data";
import { Icon } from "../ui/Icon";

interface AppointmentDrawerProps {
  conversation: Conversation;
  professionals: ProfessionalOption[];
  services: ServiceOption[];
  bookingDurations: BookingDurationSettings;
  onClose$: QRL<() => void>;
  onConfirm$: QRL<
    (
      professionalId: string,
      professionalName: string,
      serviceId: string,
      serviceName: string,
      startsAt: string,
      note: string,
    ) => void
  >;
}

export const AppointmentDrawer = component$<AppointmentDrawerProps>((props) => {
  const drawerRef = useSignal<HTMLElement>();
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const professionalId = useSignal(props.professionals[0]?.id ?? "");
  const serviceId = useSignal(props.services[0]?.id ?? "");
  const date = useSignal(businessDateInput(tomorrow));
  const selectedStartsAt = useSignal("");
  const saving = useSignal(false);
  const coverage = useSignal<PatientCoverage | "">(
    props.conversation.coverage ?? "",
  );
  const savingCoverage = useSignal(false);
  const note = useSignal("");
  const state = useStore<{
    slots: AppointmentSlot[];
    loading: boolean;
    error: string;
  }>({ slots: [], loading: true, error: "" });

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

  useVisibleTask$(async ({ track }) => {
    track(() => professionalId.value);
    track(() => coverage.value);
    track(() => date.value);
    selectedStartsAt.value = "";
    if (!coverage.value) {
      state.slots = [];
      state.loading = false;
      return;
    }
    state.loading = true;
    state.error = "";
    try {
      state.slots = await loadAvailableSlots(
        getSupabaseClient(),
        professionalId.value,
        date.value,
        coverage.value,
      );
    } catch {
      state.error = "No pudimos consultar los horarios disponibles.";
      state.slots = [];
    } finally {
      state.loading = false;
    }
  });

  const selectedProfessional =
    props.professionals.find((item) => item.id === professionalId.value) ??
    props.professionals[0];
  const selectedSlot = state.slots.find(
    (slot) => slot.startsAt === selectedStartsAt.value,
  );
  const selectedService =
    props.services.find((item) => item.id === serviceId.value) ??
    props.services[0];
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
        aria-labelledby="appointment-drawer-title"
        aria-busy={busy}
        tabIndex={-1}
        onClick$={(event) => event.stopPropagation()}
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
            <span class="eyebrow">Desde la conversación</span>
            <h2 id="appointment-drawer-title">Nuevo turno</h2>
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
            if (saving.value) return;
            if (
              !selectedProfessional ||
              !selectedService ||
              !selectedStartsAt.value
            )
              return;
            saving.value = true;
            try {
              await props.onConfirm$(
                selectedProfessional.id,
                selectedProfessional.name,
                selectedService.id,
                selectedService.name,
                selectedStartsAt.value,
                note.value.trim(),
              );
            } finally {
              saving.value = false;
            }
          }}
        >
          <div class="patient-summary">
            <span
              class={`contact-avatar avatar-${props.conversation.avatarTone}`}
            >
              {props.conversation.initials}
            </span>
            <div>
              <span>Paciente</span>
              <strong>{props.conversation.name}</strong>
              <small>{props.conversation.phone}</small>
            </div>
          </div>

          {!coverage.value ? (
            <fieldset class="coverage-picker coverage-picker-required">
              <legend>Elegí la cobertura para continuar</legend>
              <p>La duración del turno se calcula automáticamente.</p>
              <div class="coverage-options">
                {(["ioma", "particular"] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={coverage.value === value}
                    disabled={savingCoverage.value}
                    onClick$={async () => {
                      savingCoverage.value = true;
                      const { error } = await getSupabaseClient()
                        .from("contacts")
                        .update({ coverage: value })
                        .eq("id", props.conversation.contactId);
                      savingCoverage.value = false;
                      if (error) {
                        state.error = "No pudimos guardar la cobertura.";
                        return;
                      }
                      props.conversation.coverage = value;
                      coverage.value = value;
                    }}
                  >
                    {value === "ioma"
                      ? `IOMA · ${props.bookingDurations.iomaMinutes} min`
                      : `Particular · ${props.bookingDurations.privateMinutes} min`}
                  </button>
                ))}
              </div>
              {state.error && (
                <p class="login-error" role="alert">
                  {state.error}
                </p>
              )}
            </fieldset>
          ) : (
            <>
              <div class="booking-coverage-summary">
                <strong>
                  {coverage.value === "ioma" ? "IOMA" : "Particular"}
                </strong>
                <span>
                  {coverage.value === "ioma"
                    ? props.bookingDurations.iomaMinutes
                    : props.bookingDurations.privateMinutes}{" "}
                  minutos
                </span>
              </div>

              <label class="form-field">
                <span>Servicio</span>
                <div class="select-wrap">
                  <select
                    value={serviceId.value}
                    onChange$={(_, element) =>
                      (serviceId.value = element.value)
                    }
                  >
                    {props.services.map((service) => (
                      <option key={service.id} value={service.id}>
                        {service.name}
                      </option>
                    ))}
                  </select>
                  <Icon name="chevron-down" size={17} />
                </div>
              </label>

              <label class="form-field">
                <span>Fecha</span>
                <div class="input-with-icon">
                  <Icon name="calendar" size={18} />
                  <input
                    type="date"
                    min={businessDateInput()}
                    value={date.value}
                    onInput$={(_, element) => (date.value = element.value)}
                  />
                </div>
              </label>

              <fieldset class="slot-picker">
                <legend>Horarios disponibles</legend>
                <div>
                  {state.slots.map((slot) => (
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
                {state.loading ? (
                  <small>Consultando horarios…</small>
                ) : state.error ? (
                  <small>{state.error}</small>
                ) : state.slots.length === 0 ? (
                  <small>No hay horarios disponibles para esa fecha.</small>
                ) : (
                  <small>
                    {coverage.value === "ioma"
                      ? `IOMA · ${props.bookingDurations.iomaMinutes}`
                      : `Particular · ${props.bookingDurations.privateMinutes}`}{" "}
                    minutos
                  </small>
                )}
              </fieldset>

              <label class="form-field">
                <span>
                  Nota interna <em>Opcional</em>
                </span>
                <textarea
                  rows={3}
                  value={note.value}
                  placeholder="Visible solo para Gisela"
                  onInput$={(_, element) => (note.value = element.value)}
                />
              </label>

              {selectedSlot && selectedProfessional && selectedService && (
                <div class="appointment-preview">
                  <Icon name="check-circle" size={20} />
                  <p>
                    Se reservará el horario de{" "}
                    <strong>{selectedSlot.label}</strong> para{" "}
                    <strong>{selectedService.name}</strong>. Quedará esperando
                    la seña del paciente.
                  </p>
                </div>
              )}

              <div class="drawer-form-actions">
                <button
                  class="secondary-button"
                  type="button"
                  disabled={busy}
                  onClick$={() => {
                    if (!saving.value && !savingCoverage.value)
                      props.onClose$();
                  }}
                >
                  Cancelar
                </button>
                <button
                  class="primary-button"
                  type="submit"
                  disabled={
                    saving.value ||
                    !selectedStartsAt.value ||
                    !selectedProfessional ||
                    !selectedService
                  }
                >
                  {saving.value ? "Reservando…" : "Reservar horario"}
                </button>
              </div>
            </>
          )}
        </form>
      </aside>
    </div>
  );
});
