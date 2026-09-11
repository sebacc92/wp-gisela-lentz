import { component$, useContext } from "@qwik.dev/core";
import { ManualHelpLink } from "~/components/app/ManualHelpLink";
import { Icon } from "~/components/ui/Icon";
import { SETTINGS_CONTEXT } from "./SettingsContext";

/** Recordatorios automáticos del día previo y de las horas previas. */
export const RemindersSettings = component$(() => {
  const settings = useContext(SETTINGS_CONTEXT);
  const { state } = settings;
  const saveAppSettings = settings.saveAppSettings$;

  return (
    <>
      <section class="settings-block">
        <div>
          <span class="eyebrow">Sólo para Gisela</span>
          <h2>Tu agenda de mañana, a las 21 hs</h2>
          <p>
            El resumen privado llega al número personal autorizado de Gisela,
            con los turnos del día siguiente. El horario es de Buenos Aires.
          </p>
        </div>
        <div class="settings-policy-alert">
          <Icon name="message" size={18} />
          <span>
            <strong>Primero escribí desde tu WhatsApp personal</strong>
            <small>
              Cuando el resumen está habilitado, se envía sólo si mandaste un
              mensaje al WhatsApp del consultorio en las últimas 24 horas. Si la
              ventana está cerrada, ese día se omite: no se envía una plantilla
              paga.
            </small>
          </span>
        </div>
        <p>
          Podés pedir “agenda de mañana” desde ese mismo número. La autorización
          del número y la activación del resumen se configuran de forma privada;
          el odontograma queda dentro de la app.
        </p>
      </section>
      <section class="settings-block">
        <div>
          <h2>Recordatorios a pacientes</h2>
          <p>
            Configurá los avisos individuales para quienes tienen turno. Estos
            envíos son independientes del resumen privado de Gisela.
          </p>
          <ManualHelpLink
            section="automatizacion"
            label="¿Cómo funciona la atención automática?"
          />
        </div>
        <label class="settings-checkbox">
          <input
            type="checkbox"
            checked={state.reminder24h}
            disabled={!state.isAdmin}
            onChange$={(_, element) => (state.reminder24h = element.checked)}
          />
          <span>Recordar los turnos de mañana</span>
        </label>
        <label class="form-field">
          <span>Hora de envío</span>
          <input
            type="time"
            value={state.reminderDayBeforeTime}
            disabled={!state.isAdmin || !state.reminder24h}
            onInput$={(_, element) =>
              (state.reminderDayBeforeTime = element.value)
            }
          />
        </label>
        <div>
          <h3>Otro recordatorio (opcional)</h3>
          <p>
            Si querés, también podés avisar nuevamente poco antes del turno.
          </p>
        </div>
        <label class="settings-checkbox">
          <input
            type="checkbox"
            checked={state.reminder2h}
            disabled={!state.isAdmin}
            onChange$={(_, element) => (state.reminder2h = element.checked)}
          />
          <span>Enviar otro aviso el mismo día</span>
        </label>
        <label class="form-field">
          <span>Horas antes del turno</span>
          <input
            type="number"
            min={1}
            max={168}
            value={state.reminder2hMinutes / 60}
            disabled={!state.isAdmin || !state.reminder2h}
            onInput$={(_, element) =>
              (state.reminder2hMinutes = Number(element.value) * 60)
            }
          />
        </label>
        <div class="settings-policy-alert">
          <Icon name="info" size={18} />
          <span>
            <strong>Importante</strong>
            <small>
              Requieren WhatsApp y la automatización habilitados. Fuera de las
              24 horas desde el último mensaje del paciente, requieren
              consentimiento y una plantilla aprobada por Meta, que puede tener
              costo.
            </small>
          </span>
        </div>
        <button
          class="primary-button"
          type="button"
          disabled={!state.isAdmin}
          onClick$={() =>
            saveAppSettings(
              {
                reminder_24h_enabled: state.reminder24h,
                reminder_day_before_time: state.reminderDayBeforeTime,
                reminder_2h_enabled: state.reminder2h,
                reminder_2h_minutes: state.reminder2hMinutes,
              },
              "Recordatorios actualizados.",
            )
          }
        >
          Guardar recordatorios
        </button>
      </section>
    </>
  );
});
