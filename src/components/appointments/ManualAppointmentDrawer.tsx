import {
  component$,
  type QRL,
  useSignal,
  useStore,
  useVisibleTask$,
} from "@qwik.dev/core";
import { businessDateInput } from "~/lib/date-time";
import {
  createdAppointmentFromRpc,
  requestDepositAndNotify,
} from "~/lib/deposit-request";
import type {
  AppointmentSlot,
  BookingDurationSettings,
  PatientCoverage,
  ProfessionalOption,
  ServiceOption,
} from "~/lib/inbox-types";
import { normalizePhoneE164 } from "~/lib/phone";
import { getSupabaseClient } from "~/lib/supabase/client";
import { loadAvailableSlots } from "~/lib/supabase/data";
import { Icon } from "../ui/Icon";

interface PatientOption {
  id: string;
  name: string;
  phone_e164: string | null;
  coverage: PatientCoverage | null;
  is_existing_patient: boolean | null;
}

interface ManualAppointmentDrawerProps {
  professionals: ProfessionalOption[];
  services: ServiceOption[];
  bookingDurations: BookingDurationSettings;
  initialDate: string;
  initialPatientId?: string;
  onClose$: QRL<() => void>;
  onSaved$: QRL<(message: string) => void>;
}

function normalizeSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLocaleLowerCase("es-AR");
}

export const ManualAppointmentDrawer = component$<ManualAppointmentDrawerProps>(
  (props) => {
    const drawerRef = useSignal<HTMLElement>();
    const professionalId = useSignal(props.professionals[0]?.id ?? "");
    const serviceId = useSignal(props.services[0]?.id ?? "");
    const patientId = useSignal("");
    const patientMode = useSignal<"existing" | "new">("existing");
    const patientSearch = useSignal("");
    const date = useSignal(props.initialDate);
    const selectedStartsAt = useSignal("");
    const selectedCoverage = useSignal<PatientCoverage | "">("");
    const newPatientName = useSignal("");
    const newPatientPhone = useSignal("");
    const newPatientIsExisting = useSignal<boolean | null>(null);
    const note = useSignal("");
    const saving = useSignal(false);
    const savingCoverage = useSignal(false);
    const error = useSignal("");
    const state = useStore<{
      patients: PatientOption[];
      slots: AppointmentSlot[];
      loadingPatients: boolean;
      patientLoadError: boolean;
      loadingSlots: boolean;
    }>({
      patients: [],
      slots: [],
      loadingPatients: true,
      patientLoadError: false,
      loadingSlots: false,
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

    useVisibleTask$(async () => {
      const { data, error: patientError } = await getSupabaseClient()
        .from("contacts")
        .select("id,name,phone_e164,coverage,is_existing_patient")
        .order("name");
      state.patients = (data ?? []) as PatientOption[];
      state.patientLoadError = Boolean(patientError);
      const initialPatient = state.patients.find(
        (patient) => patient.id === props.initialPatientId,
      );
      if (initialPatient) {
        patientId.value = initialPatient.id;
        patientSearch.value = initialPatient.name;
        selectedCoverage.value = initialPatient.coverage ?? "";
      }
      state.loadingPatients = false;
    });

    useVisibleTask$(async ({ track }) => {
      track(() => professionalId.value);
      track(() => selectedCoverage.value);
      track(() => date.value);
      selectedStartsAt.value = "";
      if (!selectedCoverage.value) {
        state.slots = [];
        state.loadingSlots = false;
        return;
      }
      state.loadingSlots = true;
      try {
        state.slots = await loadAvailableSlots(
          getSupabaseClient(),
          professionalId.value,
          date.value,
          selectedCoverage.value,
        );
      } catch {
        state.slots = [];
      } finally {
        state.loadingSlots = false;
      }
    });

    const selectedPatient = state.patients.find(
      (patient) => patient.id === patientId.value,
    );
    const normalizedPatientSearch = normalizeSearch(patientSearch.value);
    const matchingPatients = normalizedPatientSearch
      ? state.patients
          .filter((patient) =>
            normalizeSearch(
              `${patient.name} ${patient.phone_e164 ?? ""}`,
            ).includes(normalizedPatientSearch),
          )
          .slice(0, 8)
      : [];
    const normalizedNewPatientPhone = normalizePhoneE164(newPatientPhone.value);
    const duplicatePatient = normalizedNewPatientPhone
      ? state.patients.find(
          (patient) => patient.phone_e164 === normalizedNewPatientPhone,
        )
      : undefined;
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
          aria-labelledby="manual-appointment-title"
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
              <span class="eyebrow">Agenda</span>
              <h2 id="manual-appointment-title">Nuevo turno</h2>
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
              if (!professionalId.value || !serviceId.value) return;
              if (!selectedCoverage.value) {
                error.value = "Elegí la cobertura para continuar.";
                return;
              }
              if (!selectedStartsAt.value) {
                error.value = "Elegí un horario disponible.";
                return;
              }
              if (patientMode.value === "existing" && !patientId.value) {
                error.value =
                  "Buscá y elegí un paciente, o seleccioná «Paciente nuevo».";
                return;
              }

              saving.value = true;
              error.value = "";
              const client = getSupabaseClient();
              try {
                let contactId =
                  patientMode.value === "existing" ? patientId.value : "";
                if (patientMode.value === "new") {
                  const name = newPatientName.value.trim();
                  const phone = normalizePhoneE164(newPatientPhone.value);
                  if (!name || !phone || newPatientIsExisting.value === null) {
                    error.value =
                      "Completá nombre, WhatsApp, cobertura y si ya era paciente.";
                    return;
                  }
                  if (duplicatePatient) {
                    error.value =
                      "Ese WhatsApp ya pertenece a un paciente guardado. Usá su ficha para continuar.";
                    return;
                  }
                  const { data: created, error: createError } = await client
                    .from("contacts")
                    .insert({
                      name,
                      phone_e164: phone,
                      coverage: selectedCoverage.value,
                      is_existing_patient: newPatientIsExisting.value,
                    })
                    .select("id")
                    .single();
                  if (createError?.code === "23505") {
                    error.value =
                      "Ese WhatsApp ya está guardado. Elegí el paciente existente.";
                    return;
                  }
                  if (createError || !created) throw createError;
                  contactId = created.id as string;
                }

                const { data: appointmentData, error: appointmentError } =
                  await client.rpc("create_service_appointment", {
                    p_contact_id: contactId,
                    p_professional_id: professionalId.value,
                    p_service_id: serviceId.value,
                    p_starts_at: selectedStartsAt.value,
                    p_source: "manual",
                    p_internal_note: note.value.trim() || null,
                  });
                if (appointmentError) {
                  error.value = appointmentError.message.includes(
                    "SLOT_UNAVAILABLE",
                  )
                    ? "Ese horario acaba de ocuparse. Elegí otro disponible."
                    : "No pudimos reservar el horario.";
                  return;
                }
                const createdAppointment =
                  createdAppointmentFromRpc(appointmentData);
                const notification = createdAppointment
                  ? await requestDepositAndNotify(client, {
                      appointmentId: createdAppointment.id,
                      contactId,
                      depositRequired: createdAppointment.depositRequired,
                    })
                  : { required: true, notified: false };
                await props.onSaved$(
                  notification.notified
                    ? "Horario reservado y pedido de seña enviado por WhatsApp."
                    : notification.required
                      ? "Horario reservado. No pudimos enviar el pedido de seña por WhatsApp."
                      : "Turno guardado y confirmado. La seña está desactivada.",
                );
              } catch {
                error.value =
                  "No pudimos guardar el turno. Intentá nuevamente.";
              } finally {
                saving.value = false;
              }
            }}
          >
            <fieldset class="patient-source-picker">
              <legend>1. Elegí el paciente</legend>
              <div class="patient-source-options">
                <label>
                  <input
                    type="radio"
                    name="patient-source"
                    checked={patientMode.value === "existing"}
                    onChange$={() => {
                      patientMode.value = "existing";
                      selectedCoverage.value = selectedPatient?.coverage ?? "";
                      error.value = "";
                    }}
                  />
                  Ya está registrado
                </label>
                <label>
                  <input
                    type="radio"
                    name="patient-source"
                    checked={patientMode.value === "new"}
                    onChange$={() => {
                      patientMode.value = "new";
                      patientId.value = "";
                      selectedCoverage.value = "";
                      error.value = "";
                    }}
                  />
                  Paciente nuevo
                </label>
              </div>
            </fieldset>

            {patientMode.value === "existing" && (
              <section
                class="existing-patient-chooser"
                aria-label="Buscar paciente registrado"
              >
                {selectedPatient ? (
                  <>
                    <div class="selected-patient-card" role="status">
                      <span>
                        <small>Paciente elegido</small>
                        <strong>{selectedPatient.name}</strong>
                        <em>
                          {selectedPatient.phone_e164 ??
                            "Identidad privada de WhatsApp"}
                        </em>
                      </span>
                      <button
                        class="secondary-button small"
                        type="button"
                        onClick$={() => {
                          patientId.value = "";
                          patientSearch.value = "";
                          selectedCoverage.value = "";
                        }}
                      >
                        Cambiar
                      </button>
                    </div>
                    {selectedPatient.coverage ? (
                      <div class="booking-coverage-summary">
                        <strong>
                          {selectedPatient.coverage === "ioma"
                            ? "IOMA"
                            : "Particular"}
                        </strong>
                        <span>
                          {selectedPatient.coverage === "ioma"
                            ? props.bookingDurations.iomaMinutes
                            : props.bookingDurations.privateMinutes}{" "}
                          minutos
                        </span>
                      </div>
                    ) : (
                      <fieldset class="coverage-picker">
                        <legend>Elegí solo la cobertura para continuar</legend>
                        <div class="coverage-options">
                          {(["ioma", "particular"] as const).map((coverage) => (
                            <button
                              key={coverage}
                              type="button"
                              aria-pressed={selectedCoverage.value === coverage}
                              disabled={savingCoverage.value}
                              onClick$={async () => {
                                savingCoverage.value = true;
                                const { error: updateError } =
                                  await getSupabaseClient()
                                    .from("contacts")
                                    .update({ coverage })
                                    .eq("id", selectedPatient.id);
                                savingCoverage.value = false;
                                if (updateError) {
                                  error.value =
                                    "No pudimos guardar la cobertura.";
                                  return;
                                }
                                selectedPatient.coverage = coverage;
                                selectedCoverage.value = coverage;
                              }}
                            >
                              {coverage === "ioma"
                                ? `IOMA · ${props.bookingDurations.iomaMinutes} min`
                                : `Particular · ${props.bookingDurations.privateMinutes} min`}
                            </button>
                          ))}
                        </div>
                      </fieldset>
                    )}
                  </>
                ) : (
                  <>
                    <label class="form-field" for="manual-patient-search">
                      <span>Buscar paciente</span>
                      <div class="input-with-icon">
                        <Icon name="search" size={18} />
                        <input
                          id="manual-patient-search"
                          type="search"
                          autocomplete="off"
                          placeholder="Nombre o WhatsApp"
                          value={patientSearch.value}
                          disabled={state.loadingPatients}
                          onInput$={(_, element) => {
                            patientSearch.value = element.value;
                            patientId.value = "";
                            selectedCoverage.value = "";
                          }}
                        />
                      </div>
                    </label>
                    <div class="patient-search-results" aria-live="polite">
                      {state.loadingPatients ? (
                        <p>Buscando pacientes…</p>
                      ) : state.patientLoadError ? (
                        <p role="alert">No pudimos cargar los pacientes.</p>
                      ) : !normalizedPatientSearch ? (
                        <p>Escribí un nombre o WhatsApp para buscar.</p>
                      ) : matchingPatients.length ? (
                        <ul aria-label="Pacientes encontrados">
                          {matchingPatients.map((patient) => (
                            <li key={patient.id}>
                              <button
                                type="button"
                                onClick$={() => {
                                  patientId.value = patient.id;
                                  patientSearch.value = patient.name;
                                  selectedCoverage.value =
                                    patient.coverage ?? "";
                                  error.value = "";
                                }}
                              >
                                <strong>{patient.name}</strong>
                                <small>
                                  {patient.phone_e164 ??
                                    "Identidad privada de WhatsApp"}
                                </small>
                              </button>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <div class="patient-search-empty">
                          <p>No encontramos ese paciente.</p>
                          <button
                            class="secondary-button small"
                            type="button"
                            onClick$={() => {
                              patientMode.value = "new";
                              newPatientName.value = patientSearch.value;
                              selectedCoverage.value = "";
                            }}
                          >
                            Cargar como paciente nuevo
                          </button>
                        </div>
                      )}
                    </div>
                  </>
                )}
              </section>
            )}

            {patientMode.value === "new" && (
              <div class="manual-patient-fields">
                <label class="form-field">
                  <span>Nombre y apellido</span>
                  <input
                    required
                    value={newPatientName.value}
                    onInput$={(_, element) =>
                      (newPatientName.value = element.value)
                    }
                  />
                </label>
                <label class="form-field">
                  <span>WhatsApp</span>
                  <input
                    required
                    inputMode="tel"
                    placeholder="+54 9…"
                    value={newPatientPhone.value}
                    onInput$={(_, element) =>
                      (newPatientPhone.value = element.value)
                    }
                  />
                </label>
                {duplicatePatient && (
                  <div class="duplicate-patient-notice" role="alert">
                    <p>
                      Ese WhatsApp ya está guardado como{" "}
                      <strong>{duplicatePatient.name}</strong>.
                    </p>
                    <button
                      class="secondary-button small"
                      type="button"
                      onClick$={() => {
                        patientMode.value = "existing";
                        patientId.value = duplicatePatient.id;
                        patientSearch.value = duplicatePatient.name;
                        selectedCoverage.value =
                          duplicatePatient.coverage ?? "";
                      }}
                    >
                      Usar paciente guardado
                    </button>
                  </div>
                )}
                <fieldset class="coverage-picker">
                  <legend>Cobertura</legend>
                  <div class="coverage-options">
                    {(["ioma", "particular"] as const).map((coverage) => (
                      <button
                        key={coverage}
                        class={{
                          selected: selectedCoverage.value === coverage,
                        }}
                        type="button"
                        aria-pressed={selectedCoverage.value === coverage}
                        onClick$={() => (selectedCoverage.value = coverage)}
                      >
                        {coverage === "ioma"
                          ? `IOMA · ${props.bookingDurations.iomaMinutes} min`
                          : `Particular · ${props.bookingDurations.privateMinutes} min`}
                      </button>
                    ))}
                  </div>
                </fieldset>
                <fieldset class="coverage-picker">
                  <legend>¿Ya era paciente de Gisela?</legend>
                  <div class="coverage-options">
                    <button
                      class={{ selected: newPatientIsExisting.value === true }}
                      type="button"
                      aria-pressed={newPatientIsExisting.value === true}
                      onClick$={() => (newPatientIsExisting.value = true)}
                    >
                      Sí
                    </button>
                    <button
                      class={{ selected: newPatientIsExisting.value === false }}
                      type="button"
                      aria-pressed={newPatientIsExisting.value === false}
                      onClick$={() => (newPatientIsExisting.value = false)}
                    >
                      No
                    </button>
                  </div>
                </fieldset>
              </div>
            )}

            {(patientMode.value === "new" ||
              (selectedPatient && selectedCoverage.value)) && (
              <>
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
                  <legend>Hora</legend>
                  <div>
                    {state.slots.map((slot) => (
                      <button
                        key={slot.startsAt}
                        type="button"
                        class={{
                          selected: selectedStartsAt.value === slot.startsAt,
                        }}
                        onClick$={() =>
                          (selectedStartsAt.value = slot.startsAt)
                        }
                      >
                        {slot.label}
                      </button>
                    ))}
                  </div>
                  <small>
                    {!selectedCoverage.value
                      ? "Primero elegí la cobertura del paciente."
                      : state.loadingSlots
                        ? "Consultando horarios…"
                        : state.slots.length
                          ? `${selectedCoverage.value === "ioma" ? `IOMA · ${props.bookingDurations.iomaMinutes}` : `Particular · ${props.bookingDurations.privateMinutes}`} minutos`
                          : "No hay horarios disponibles para ese día."}
                  </small>
                </fieldset>

                <label class="form-field">
                  <span>
                    Notas administrativas <em>Opcional</em>
                  </span>
                  <textarea
                    rows={3}
                    value={note.value}
                    onInput$={(_, element) => (note.value = element.value)}
                  />
                </label>
              </>
            )}
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
                Cancelar
              </button>
              {(patientMode.value === "new" ||
                (selectedPatient && selectedCoverage.value)) && (
                <button
                  class="primary-button"
                  type="submit"
                  disabled={
                    saving.value ||
                    !selectedStartsAt.value ||
                    !serviceId.value ||
                    !selectedCoverage.value
                  }
                >
                  {saving.value ? "Guardando…" : "Reservar horario"}
                </button>
              )}
            </div>
          </form>
        </aside>
      </div>
    );
  },
);
