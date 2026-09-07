import { OrthodonticVisitPicker } from "./OrthodonticVisitPicker";
import {
  component$,
  type QRL,
  useSignal,
  useStore,
  useVisibleTask$,
} from "@qwik.dev/core";
import {
  convertCalendarBlock,
  describeBlockConversionError,
} from "~/lib/calendar-block-conversion";
import { formatBusinessDate } from "~/lib/date-time";
import {
  matchCalendarPatientContact,
  matchCalendarPatientService,
  parseCalendarPatientTitle,
} from "~/lib/calendar-patient-title";
import type {
  PatientCoverage,
  OrthodonticVisitType,
  ProfessionalOption,
  ServiceOption,
} from "~/lib/inbox-types";
import { getSupabaseClient } from "~/lib/supabase/client";
import { normalizePhoneE164 } from "~/lib/phone";
import type { CalendarBlock } from "~/lib/supabase/data";
import { Icon } from "../ui/Icon";

interface PatientOption {
  id: string;
  name: string;
  phone_e164: string | null;
  alternate_phone_e164: string | null;
  coverage: PatientCoverage | null;
}

interface ConvertBlockDrawerProps {
  block: CalendarBlock;
  professionals: ProfessionalOption[];
  services: ServiceOption[];
  onClose$: QRL<() => void>;
  onConverted$: QRL<(message: string) => void>;
}

/**
 * Convertir un bloqueo importado en un turno real. Abrir o cancelar este
 * formulario no toca nada: el bloqueo sigue ocupando el horario hasta que el
 * RPC lo retira y crea el turno en la misma transacción.
 */
export const ConvertBlockDrawer = component$<ConvertBlockDrawerProps>(
  (props) => {
    const titleHints = parseCalendarPatientTitle(props.block.summary);
    const drawerRef = useSignal<HTMLElement>();
    const patientId = useSignal("");
    const patientMode = useSignal<"existing" | "new">("existing");
    const newPatientName = useSignal(titleHints.name ?? "");
    const newPatientPhone = useSignal(titleHints.phoneE164 ?? "");
    const newPatientIsExisting = useSignal<boolean | null>(
      titleHints.isExistingPatient,
    );
    const selectedCoverage = useSignal<PatientCoverage | "">(
      titleHints.coverage ?? "",
    );
    const appliedPatientSuggestion = useSignal(false);
    const patientSuggestionNotice = useSignal("");
    const professionalId = useSignal(props.professionals[0]?.id ?? "");
    const serviceId = useSignal(
      matchCalendarPatientService(titleHints, props.services) ?? "",
    );
    const orthodonticVisit = useSignal<OrthodonticVisitType | "">(
      titleHints.orthodonticVisitType ?? "",
    );
    const note = useSignal("");
    const saving = useSignal(false);
    const patientReloadVersion = useSignal(0);
    const error = useSignal("");
    const state = useStore<{
      patients: PatientOption[];
      loading: boolean;
      loadError: boolean;
    }>({
      patients: [],
      loading: true,
      loadError: false,
    });

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
      track(() => patientReloadVersion.value);
      let cancelled = false;
      cleanup(() => {
        cancelled = true;
      });
      state.loading = true;
      state.loadError = false;
      try {
        const { data, error: patientsError } = await getSupabaseClient()
          .from("contacts")
          .select("id,name,phone_e164,alternate_phone_e164,coverage")
          .order("name");
        if (patientsError) throw patientsError;
        if (cancelled) return;
        state.patients = (data ?? []) as PatientOption[];
        if (!appliedPatientSuggestion.value) {
          const match = matchCalendarPatientContact(titleHints, state.patients);
          const patient = state.patients.find(
            (candidate) => candidate.id === match.contactId,
          );
          if (patient) {
            patientId.value = patient.id;
            selectedCoverage.value =
              titleHints.coverage ?? patient.coverage ?? "";
            patientSuggestionNotice.value =
              "Encontramos este paciente por los datos del título. Revisá la selección antes de convertir.";
          } else if (
            match.reason === "ambiguous" ||
            match.reason === "phone_name_conflict"
          ) {
            patientSuggestionNotice.value =
              "Los datos del título coinciden con más de una ficha o no coinciden entre sí. Elegí el paciente correcto.";
          } else if (titleHints.isPatientCandidate) {
            patientSuggestionNotice.value =
              "No encontramos una ficha que coincida con el título. Podés elegir un paciente o crear su ficha acá.";
          }
          appliedPatientSuggestion.value = true;
        }
      } catch {
        if (cancelled) return;
        patientId.value = "";
        state.patients = [];
        state.loadError = true;
      } finally {
        if (!cancelled) state.loading = false;
      }
    });

    const selectedPatient = state.patients.find(
      (patient) => patient.id === patientId.value,
    );
    const selectedService = props.services.find(
      (service) => service.id === serviceId.value,
    );
    const normalizedNewPatientPhone = normalizePhoneE164(newPatientPhone.value);
    const duplicatePatient = normalizedNewPatientPhone
      ? state.patients.find(
          (patient) =>
            patient.phone_e164 === normalizedNewPatientPhone ||
            patient.alternate_phone_e164 === normalizedNewPatientPhone,
        )
      : undefined;
    const effectiveCoverage =
      selectedCoverage.value ||
      (patientMode.value === "existing" ? selectedPatient?.coverage : null);
    const ready = Boolean(
      !state.loading &&
      !state.loadError &&
      effectiveCoverage &&
      (patientMode.value === "existing"
        ? selectedPatient
        : newPatientName.value.trim() &&
          normalizedNewPatientPhone &&
          !duplicatePatient) &&
      professionalId.value &&
      serviceId.value &&
      (!selectedService?.requiresOrthodonticIntake || orthodonticVisit.value),
    );

    return (
      <div
        class="drawer-layer"
        role="presentation"
        onClick$={() => {
          if (!saving.value) props.onClose$();
        }}
      >
        <aside
          ref={drawerRef}
          class="drawer appointment-drawer"
          role="dialog"
          aria-modal="true"
          aria-labelledby="convert-block-title"
          aria-busy={saving.value}
          tabIndex={-1}
          stoppropagation:click
          onKeyDown$={(event) => {
            if (event.key === "Escape" && !saving.value) {
              event.preventDefault();
              props.onClose$();
            }
          }}
        >
          <header class="drawer-header">
            <div>
              <span class="eyebrow">Desde Google Calendar</span>
              <h2 id="convert-block-title">Convertir en turno</h2>
            </div>
            <button
              class="icon-button"
              type="button"
              aria-label="Cerrar sin convertir el bloqueo"
              disabled={saving.value}
              onClick$={() => {
                if (!saving.value) props.onClose$();
              }}
            >
              <Icon name="x" size={20} />
            </button>
          </header>

          <form
            class="appointment-form"
            preventdefault:submit
            onSubmit$={async () => {
              if (saving.value || !ready) return;
              saving.value = true;
              error.value = "";
              try {
                const result = await convertCalendarBlock(getSupabaseClient(), {
                  googleEventId: props.block.googleEventId,
                  contactId:
                    patientMode.value === "existing" ? patientId.value : null,
                  patientName:
                    patientMode.value === "new" ? newPatientName.value : null,
                  patientPhone:
                    patientMode.value === "new"
                      ? normalizedNewPatientPhone
                      : null,
                  coverage: effectiveCoverage || null,
                  isExistingPatient:
                    patientMode.value === "new"
                      ? newPatientIsExisting.value
                      : null,
                  professionalId: professionalId.value,
                  serviceId: serviceId.value,
                  startsAt: props.block.startsAt,
                  internalNote: note.value,
                  orthodonticVisitType:
                    selectedService?.requiresOrthodonticIntake
                      ? orthodonticVisit.value || null
                      : null,
                });
                if (result.error) {
                  error.value = describeBlockConversionError(result.error);
                  return;
                }
                await props.onConverted$(
                  result.created
                    ? "Turno guardado. Se conserva el evento original en Google Calendar."
                    : "Ese bloqueo ya se había convertido en un turno.",
                );
              } catch {
                error.value =
                  "No pudimos confirmar si el bloqueo se convirtió. Cerrá y revisá la agenda antes de volver a intentar.";
              } finally {
                saving.value = false;
              }
            }}
          >
            <div class="convert-block-summary">
              <Icon name="calendar" size={18} />
              <div>
                <strong>
                  {formatBusinessDate(new Date(props.block.startsAt), {
                    dateStyle: "full",
                    timeStyle: "short",
                  })}
                </strong>
                <span>{props.block.summary || "Evento sin título"}</span>
                <span>
                  Hasta las{" "}
                  {formatBusinessDate(new Date(props.block.endsAt), {
                    timeStyle: "short",
                  })}
                  . Se conserva el horario de Google.
                </span>
              </div>
            </div>

            <p class="settings-note">
              El turno conserva el horario y el evento original de Google
              Calendar. No se crea otro evento. Convertir no envía una respuesta
              al paciente; los recordatorios siguen la configuración de la
              agenda.
            </p>

            {(patientSuggestionNotice.value ||
              titleHints.uncertainties.length > 0) && (
              <p class="settings-note" role="status">
                {patientSuggestionNotice.value}{" "}
                {titleHints.uncertainties.join(" ")}
              </p>
            )}

            <fieldset class="patient-source-picker">
              <legend>Paciente</legend>
              <div class="patient-source-options">
                <label>
                  <input
                    type="radio"
                    name="convert-patient-source"
                    checked={patientMode.value === "existing"}
                    disabled={saving.value}
                    onChange$={() => {
                      patientMode.value = "existing";
                      selectedCoverage.value =
                        titleHints.coverage ?? selectedPatient?.coverage ?? "";
                      orthodonticVisit.value =
                        titleHints.orthodonticVisitType ?? "";
                      error.value = "";
                    }}
                  />
                  Paciente registrado
                </label>
                <label>
                  <input
                    type="radio"
                    name="convert-patient-source"
                    checked={patientMode.value === "new"}
                    disabled={saving.value}
                    onChange$={() => {
                      patientMode.value = "new";
                      selectedCoverage.value = titleHints.coverage ?? "";
                      orthodonticVisit.value =
                        titleHints.orthodonticVisitType ?? "";
                      error.value = "";
                    }}
                  />
                  Crear paciente
                </label>
              </div>
            </fieldset>

            {patientMode.value === "existing" && (
              <label class="form-field">
                <span>Paciente</span>
                <div class="select-wrap">
                  <select
                    value={patientId.value}
                    disabled={state.loading || state.loadError || saving.value}
                    onChange$={(_, element) => {
                      patientId.value = element.value;
                      selectedCoverage.value =
                        titleHints.coverage ??
                        state.patients.find(
                          (patient) => patient.id === element.value,
                        )?.coverage ??
                        "";
                      orthodonticVisit.value = "";
                    }}
                  >
                    <option value="">
                      {state.loading
                        ? "Cargando…"
                        : state.loadError
                          ? "Pacientes no disponibles"
                          : "Elegí un paciente"}
                    </option>
                    {state.patients.map((patient) => (
                      <option key={patient.id} value={patient.id}>
                        {`${patient.name}${patient.phone_e164 ? ` · ${patient.phone_e164}` : ""}`}
                      </option>
                    ))}
                  </select>
                  <Icon name="chevron-down" size={17} />
                </div>
              </label>
            )}

            {patientMode.value === "new" && (
              <div class="manual-patient-fields">
                <p class="settings-note">
                  Revisá los datos tomados del título. La ficha se guarda junto
                  con el turno al confirmar.
                </p>
                <label class="form-field">
                  <span>Nombre y apellido</span>
                  <input
                    required
                    autocomplete="name"
                    value={newPatientName.value}
                    disabled={saving.value}
                    onInput$={(_, element) =>
                      (newPatientName.value = element.value)
                    }
                  />
                </label>
                <label class="form-field">
                  <span>WhatsApp</span>
                  <input
                    required
                    type="tel"
                    autocomplete="tel"
                    placeholder="+54 9…"
                    value={newPatientPhone.value}
                    disabled={saving.value}
                    onInput$={(_, element) =>
                      (newPatientPhone.value = element.value)
                    }
                  />
                  {!titleHints.phoneE164 && !newPatientPhone.value && (
                    <small>
                      El título no incluye un teléfono. Completalo para crear la
                      ficha.
                    </small>
                  )}
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
                      disabled={saving.value}
                      onClick$={() => {
                        patientMode.value = "existing";
                        patientId.value = duplicatePatient.id;
                        selectedCoverage.value =
                          titleHints.coverage ??
                          duplicatePatient.coverage ??
                          "";
                        orthodonticVisit.value =
                          titleHints.orthodonticVisitType ?? "";
                        error.value = "";
                      }}
                    >
                      Usar paciente guardado
                    </button>
                  </div>
                )}
                <label class="form-field">
                  <span>
                    ¿Ya era paciente de Gisela? <em>Opcional</em>
                  </span>
                  <div class="select-wrap">
                    <select
                      value={
                        newPatientIsExisting.value === null
                          ? ""
                          : String(newPatientIsExisting.value)
                      }
                      disabled={saving.value}
                      onChange$={(_, element) => {
                        newPatientIsExisting.value =
                          element.value === ""
                            ? null
                            : element.value === "true";
                      }}
                    >
                      <option value="">Sin confirmar</option>
                      <option value="true">Sí, ya tiene ficha</option>
                      <option value="false">No, es su primera vez</option>
                    </select>
                    <Icon name="chevron-down" size={17} />
                  </div>
                </label>
              </div>
            )}

            {state.loadError && (
              <div class="patient-search-empty" role="alert">
                <p>
                  No pudimos cargar los pacientes. El bloqueo sigue ocupando el
                  horario y no se hizo ningún cambio.
                </p>
                <button
                  class="secondary-button small"
                  type="button"
                  onClick$={() => (patientReloadVersion.value += 1)}
                >
                  Reintentar
                </button>
              </div>
            )}

            {(patientMode.value === "new" || selectedPatient) && (
              <fieldset class="coverage-picker">
                <legend>Cobertura</legend>
                <div class="coverage-options">
                  {(["ioma", "particular"] as const).map((coverage) => (
                    <button
                      key={coverage}
                      type="button"
                      class={{ selected: selectedCoverage.value === coverage }}
                      aria-pressed={selectedCoverage.value === coverage}
                      disabled={saving.value}
                      onClick$={() => (selectedCoverage.value = coverage)}
                    >
                      {coverage === "ioma" ? "IOMA" : "Particular"}
                    </button>
                  ))}
                </div>
                {patientMode.value === "existing" &&
                  selectedPatient?.coverage &&
                  titleHints.coverage &&
                  selectedPatient.coverage !== titleHints.coverage && (
                    <p class="settings-note">
                      La ficha indica{" "}
                      {selectedPatient.coverage === "ioma"
                        ? "IOMA"
                        : "Particular"}{" "}
                      y el título indica{" "}
                      {titleHints.coverage === "ioma" ? "IOMA" : "Particular"}.
                      Elegí cuál corresponde a este turno.
                    </p>
                  )}
                {patientMode.value === "existing" &&
                  !selectedPatient?.coverage && (
                    <p class="settings-note">
                      La cobertura se completa en la ficha al convertir el
                      turno.
                    </p>
                  )}
              </fieldset>
            )}

            <label class="form-field">
              <span>Servicio</span>
              <div class="select-wrap">
                <select
                  value={serviceId.value}
                  disabled={saving.value}
                  onChange$={(_, element) => {
                    serviceId.value = element.value;
                    orthodonticVisit.value = "";
                  }}
                >
                  <option value="">Elegí un servicio</option>
                  {props.services.map((service) => (
                    <option key={service.id} value={service.id}>
                      {service.name}
                    </option>
                  ))}
                </select>
                <Icon name="chevron-down" size={17} />
              </div>
            </label>

            {selectedService?.requiresOrthodonticIntake && (
              <OrthodonticVisitPicker
                value={orthodonticVisit.value}
                disabled={saving.value}
                onChange$={(value) => {
                  orthodonticVisit.value = value;
                  error.value = "";
                }}
              />
            )}

            <label class="form-field">
              <span>Profesional</span>
              <div class="select-wrap">
                <select
                  value={professionalId.value}
                  disabled={saving.value}
                  onChange$={(_, element) =>
                    (professionalId.value = element.value)
                  }
                >
                  {props.professionals.map((professional) => (
                    <option key={professional.id} value={professional.id}>
                      {professional.name}
                    </option>
                  ))}
                </select>
                <Icon name="chevron-down" size={17} />
              </div>
            </label>

            <label class="form-field">
              <span>
                Nota interna <em>Opcional</em>
              </span>
              <textarea
                rows={2}
                value={note.value}
                disabled={saving.value}
                placeholder="Visible solo para Gisela"
                onInput$={(_, element) => (note.value = element.value)}
              />
            </label>

            {error.value && (
              <p class="login-error" role="alert">
                {error.value}
              </p>
            )}

            <div class="drawer-form-actions">
              <button
                class="secondary-button"
                type="button"
                disabled={saving.value}
                onClick$={() => {
                  if (!saving.value) props.onClose$();
                }}
              >
                Cancelar
              </button>
              <button
                class="primary-button"
                type="submit"
                disabled={saving.value || !ready}
              >
                {saving.value ? "Convirtiendo…" : "Convertir en turno"}
              </button>
            </div>
          </form>
        </aside>
      </div>
    );
  },
);
