import { component$, useContext } from "@qwik.dev/core";
import { ManualHelpLink } from "~/components/app/ManualHelpLink";
import { Icon } from "~/components/ui/Icon";
import { containsRestrictedAutomationRequest } from "~/lib/automation-policy";
import { BotPlayground } from "./BotPlayground";
import { SETTINGS_CONTEXT } from "./SettingsContext";

/** Mensajes automáticos: bienvenida, fuera de hora, urgencias e información. */
export const AutomationSettings = component$(() => {
  const settings = useContext(SETTINGS_CONTEXT);
  const { state } = settings;
  const saveAppSettings = settings.saveAppSettings$;

  return (
    <>
      <section class="settings-block">
        <div>
          <h2>Mensajes automáticos</h2>
          <p>
            Estas respuestas se envían solas. Revisalas con cuidado; si alguien
            menciona una urgencia, la conversación pasa a una persona.
          </p>
          <ManualHelpLink
            section="automatizacion"
            label="¿Cómo funciona la atención automática?"
          />
        </div>
        <label class="settings-checkbox">
          <input
            type="checkbox"
            checked={state.outOfHoursEnabled}
            disabled={!state.isAdmin}
            onChange$={(_, element) =>
              (state.outOfHoursEnabled = element.checked)
            }
          />
          <span>Responder fuera de horario</span>
        </label>
        <label class="form-field automation-message-field">
          <span>Mensaje fuera de horario</span>
          <textarea
            rows={4}
            maxLength={1024}
            value={state.outOfHoursMessage}
            disabled={!state.isAdmin}
            onInput$={(_, element) => (state.outOfHoursMessage = element.value)}
          />
        </label>
        <label class="form-field">
          <span>No repetir antes de (minutos)</span>
          <input
            type="number"
            min={60}
            max={10080}
            value={state.outOfHoursCooldownMinutes}
            disabled={!state.isAdmin}
            onInput$={(_, element) =>
              (state.outOfHoursCooldownMinutes = Number(element.value))
            }
          />
        </label>
        <label class="form-field automation-message-field">
          <span>Mensaje ante urgencia</span>
          <textarea
            rows={4}
            maxLength={1024}
            value={state.urgentMessage}
            disabled={!state.isAdmin}
            onInput$={(_, element) => (state.urgentMessage = element.value)}
          />
        </label>
        <label class="form-field automation-message-field">
          <span>Información general</span>
          <textarea
            rows={4}
            maxLength={1024}
            placeholder="Solo completar con dirección, horarios o datos confirmados."
            value={state.generalInfoMessage}
            disabled={!state.isAdmin}
            onInput$={(_, element) =>
              (state.generalInfoMessage = element.value)
            }
          />
        </label>
        <div>
          <h3>Asistente de IA para información administrativa</h3>
          <p>
            Puede redactar únicamente respuestas sobre horarios y ubicación
            usando la dirección y las reglas de horarios ya configuradas. No
            recibe el mensaje original ni datos del paciente.
          </p>
        </div>
        <label class="settings-checkbox">
          <input
            type="checkbox"
            checked={state.aiEnabled}
            disabled={!state.isAdmin}
            onChange$={(_, element) => (state.aiEnabled = element.checked)}
          />
          <span>Usar IA sólo para horarios y ubicación</span>
        </label>
        <label class="settings-checkbox">
          <input
            type="checkbox"
            checked={state.aiMediaEnabled}
            disabled={!state.isAdmin}
            onChange$={(_, element) => (state.aiMediaEnabled = element.checked)}
          />
          <span>
            Transcribir audios y leer comprobantes con IA
            <small>
              Envía el audio o el comprobante recibido para transcribirlo o
              copiar sus datos. Si el comprobante es legible y coinciden el
              monto y el alias o titular, la seña y el turno se confirman
              automáticamente. Si no, lo revisás vos. Siempre podés revisar el
              archivo y cancelar el turno después.
            </small>
          </span>
        </label>
        <label class="form-field">
          <span>Modelo fijado por el backend</span>
          <input type="text" value={state.aiModel} readOnly disabled />
        </label>
        <div class="settings-policy-alert">
          <Icon name="info" size={18} />
          <span>
            <strong>La IA tiene un interruptor independiente</strong>
            <small>
              Aunque se marque acá, no funciona mientras las automatizaciones
              globales estén apagadas. Ante datos faltantes o una consulta
              sensible, deriva a Gisela.
            </small>
          </span>
        </div>
        {containsRestrictedAutomationRequest(
          `${state.outOfHoursMessage} ${state.urgentMessage} ${state.generalInfoMessage}`,
        ) && (
          <div class="settings-policy-alert" role="alert">
            <Icon name="alert" size={18} />
            <span>
              <strong>Este mensaje pide datos que no corresponden</strong>
              <small>
                Quitá pedidos de documentos, datos bancarios o información
                médica antes de guardar.
              </small>
            </span>
          </div>
        )}
        <button
          class="primary-button"
          type="button"
          disabled={
            !state.isAdmin ||
            containsRestrictedAutomationRequest(
              `${state.outOfHoursMessage} ${state.urgentMessage} ${state.generalInfoMessage}`,
            )
          }
          onClick$={() =>
            saveAppSettings(
              {
                out_of_hours_enabled: state.outOfHoursEnabled,
                out_of_hours_message: state.outOfHoursMessage.trim(),
                out_of_hours_cooldown_minutes: state.outOfHoursCooldownMinutes,
                urgent_message: state.urgentMessage.trim(),
                general_info_message: state.generalInfoMessage.trim() || null,
                ai_enabled: state.aiEnabled,
                ai_media_enabled: state.aiMediaEnabled,
                ai_model: "gpt-5.6-luna",
              },
              "Automatización guardada.",
            )
          }
        >
          Guardar mensajes
        </button>
      </section>

      <BotPlayground />
    </>
  );
});
