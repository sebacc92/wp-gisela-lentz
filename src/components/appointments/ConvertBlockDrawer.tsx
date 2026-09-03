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
  ProfessionalOption,
  ServiceOption,
} from "~/lib/inbox-types";
import { getSupabaseClient } from "~/lib/supabase/client";
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
    const note = useSignal("");
    const saving = useSignal(false);
    const error = useSignal("");
    const state = useStore<{ patients: PatientOption[]; loading: boolean }>({
      patients: [],
      loading: true,
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

    useVisibleTask$(async () => {
      const { data } = await getSupabaseClient()
        .from("contacts")
        .select("id,name,coverage")
        .order("name");
      state.patients = (data ?? []) as PatientOption[];
      state.loading = false;
    });

    const selectedPatient = state.patients.find(
      (patient) => patient.id === patientId.value,
    );
    const ready = Boolean(
      patientId.value && professionalId.value && serviceId.value,
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
          onClick$={(event) => event.stopPropagation()}
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
                });
                if (result.error) {
                  error.value = describeBlockConversionError(result.error);
                  return;
                }
                await props.onConverted$(
                  result.created
                    ? "Listo. El bloqueo pasó a ser un turno y el evento original se retira de Google."
                    : "Ese bloqueo ya se había convertido en un turno.",
                );
              } catch {
                error.value =
                  "No pudimos convertir el bloqueo. No se hicieron cambios; intentá de nuevo.";
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
                  disabled={state.loading}
                  onChange$={(_, element) => (patientId.value = element.value)}
                >
                  <option value="">
                    {state.loading ? "Cargando…" : "Elegí un paciente"}
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
                  onChange$={(_, element) => (serviceId.value = element.value)}
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
              <span>Profesional</span>
              <div class="select-wrap">
                <select
                  value={professionalId.value}
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
