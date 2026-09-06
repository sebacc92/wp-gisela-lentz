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
import type {
  PatientCoverage,
  OrthodonticVisitType,
  ProfessionalOption,
  ServiceOption,
} from "~/lib/inbox-types";
import { getSupabaseClient } from "~/lib/supabase/client";
import {
  calendarProjectionNotice,
  verifyAppointmentCalendar,
} from "~/lib/calendar-projection";
import type { CalendarBlock } from "~/lib/supabase/data";
import { Icon } from "../ui/Icon";

interface PatientOption {
  id: string;
  name: string;
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
    const drawerRef = useSignal<HTMLElement>();
    const patientId = useSignal("");
    const professionalId = useSignal(props.professionals[0]?.id ?? "");
    const serviceId = useSignal(props.services[0]?.id ?? "");
    const orthodonticVisit = useSignal<OrthodonticVisitType | "">("");
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
          .select("id,name,coverage")
          .order("name");
        if (patientsError) throw patientsError;
        if (cancelled) return;
        state.patients = (data ?? []) as PatientOption[];
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
    const ready = Boolean(
      !state.loading &&
      !state.loadError &&
      selectedPatient?.coverage &&
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
                  contactId: patientId.value,
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
                const calendarState = result.appointmentId
                  ? await verifyAppointmentCalendar(
                      getSupabaseClient(),
                      result.appointmentId,
                    )
                  : "unavailable";
                await props.onConverted$(
                  calendarState !== "synced"
                    ? calendarProjectionNotice(calendarState)
                    : result.created
                      ? "Listo. El bloqueo pasó a ser un turno y el evento original se retira de Google."
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
              </div>
            </div>

            <p class="settings-note">
              El evento que creaste a mano en Google se reemplaza por el turno:
              queda un único evento, el que administra la aplicación. El
              original se retira de Google recién cuando el turno ya está
              exportado.
            </p>

            <label class="form-field">
              <span>Paciente</span>
              <div class="select-wrap">
                <select
                  value={patientId.value}
                  disabled={state.loading || state.loadError || saving.value}
                  onChange$={(_, element) => {
                    patientId.value = element.value;
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
                      {patient.name}
                    </option>
                  ))}
                </select>
                <Icon name="chevron-down" size={17} />
              </div>
            </label>

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

            {selectedPatient && !selectedPatient.coverage && (
              <p class="login-error" role="alert">
                Ese paciente todavía no tiene cobertura cargada. Completala en
                su ficha para poder calcular la duración.
              </p>
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
