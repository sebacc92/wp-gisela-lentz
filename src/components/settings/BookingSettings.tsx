import { component$, useContext } from "@qwik.dev/core";
import { ManualHelpLink } from "~/components/app/ManualHelpLink";
import { Icon } from "~/components/ui/Icon";
import { SETTINGS_CONTEXT } from "./SettingsContext";

/** Reservas y seña: importe, alias, vigencia de la pre-reserva y duraciones. */
export const BookingSettings = component$(() => {
  const settings = useContext(SETTINGS_CONTEXT);
  const { state } = settings;
  const saveAppSettings = settings.saveAppSettings$;

  return (
    <div class="settings-stack booking-settings">
      <section class="settings-block">
        <div>
          <h2>WhatsApp y reservas</h2>
          <p>
            Definí la seña y cuánto dura cada turno. Después, el sistema usa
            estos datos automáticamente al ofrecer un horario.
          </p>
          <ManualHelpLink section="senas" label="¿Cómo funcionan las señas?" />
        </div>

        <label class="settings-checkbox">
          <input
            type="checkbox"
            checked={state.depositEnabled}
            disabled={!state.isAdmin}
            onChange$={(_, element) => (state.depositEnabled = element.checked)}
          />
          <span>Pedir una seña para reservar un turno nuevo</span>
        </label>

        <div class="settings-form-grid">
          <label class="form-field">
            <span>Monto de la seña</span>
            <input
              type="number"
              min={1}
              max={100000000}
              step={1}
              value={state.depositAmountArs}
              disabled={!state.isAdmin}
              onInput$={(_, element) =>
                (state.depositAmountArs = Number(element.value))
              }
            />
            <small>En pesos argentinos, sin puntos ni comas.</small>
          </label>
          <label class="form-field">
            <span>Alias para transferir</span>
            <input
              value={state.depositAlias}
              disabled={!state.isAdmin}
              minLength={3}
              placeholder="Ej. GISELA.TURNOS"
              onInput$={(_, element) => (state.depositAlias = element.value)}
            />
          </label>
          <label class="form-field">
            <span>Titular de la cuenta</span>
            <input
              value={state.depositHolder}
              disabled={!state.isAdmin}
              minLength={3}
              placeholder="Nombre que verá el paciente"
              onInput$={(_, element) => (state.depositHolder = element.value)}
            />
          </label>
          <label class="form-field">
            <span>Minutos para enviar el comprobante</span>
            <input
              type="number"
              min={5}
              max={1440}
              step={5}
              value={state.bookingHoldMinutes}
              disabled={!state.isAdmin}
              onInput$={(_, element) =>
                (state.bookingHoldMinutes = Number(element.value))
              }
            />
            <small>Durante este tiempo el horario queda reservado.</small>
          </label>
        </div>
      </section>

      <section class="settings-block">
        <div>
          <h2>Duración según cobertura</h2>
          <p>
            Gisela atiende únicamente por IOMA o de forma particular. La agenda
            aplica la duración configurada para cada opción.
          </p>
        </div>
        <div class="settings-form-grid">
          <label class="form-field">
            <span>Turno IOMA (minutos)</span>
            <input
              type="number"
              min={5}
              max={480}
              step={5}
              value={state.iomaDurationMinutes}
              disabled={!state.isAdmin}
              onInput$={(_, element) =>
                (state.iomaDurationMinutes = Number(element.value))
              }
            />
          </label>
          <label class="form-field">
            <span>Turno particular (minutos)</span>
            <input
              type="number"
              min={5}
              max={480}
              step={5}
              value={state.privateDurationMinutes}
              disabled={!state.isAdmin}
              onInput$={(_, element) =>
                (state.privateDurationMinutes = Number(element.value))
              }
            />
          </label>
        </div>
      </section>

      <section class="settings-block">
        <div>
          <h2>Mensajes de WhatsApp</h2>
          <p>
            Estos textos se envían solos durante la reserva. Podés cambiarlos
            sin tocar ninguna configuración técnica.
          </p>
        </div>
        <label class="form-field automation-message-field">
          <span>Mensaje de bienvenida</span>
          <textarea
            rows={5}
            maxLength={1024}
            value={state.automationWelcomeMessage}
            disabled={!state.isAdmin}
            onInput$={(_, element) =>
              (state.automationWelcomeMessage = element.value)
            }
          />
        </label>
        <label class="form-field automation-message-field">
          <span>Pedido de seña</span>
          <textarea
            rows={6}
            maxLength={1024}
            value={state.depositRequestMessageTemplate}
            disabled={!state.isAdmin}
            onInput$={(_, element) =>
              (state.depositRequestMessageTemplate = element.value)
            }
          />
          <small>
            Podés usar {"{deposit_amount}"}, {"{deposit_alias}"},
            {" {deposit_holder}"}, {"{date}"} y {"{time}"}.
          </small>
        </label>

        <details class="settings-message-options">
          <summary>Ver otros mensajes de la reserva</summary>
          <div class="settings-message-options-content">
            <label class="form-field automation-message-field">
              <span>Cuando un comprobante queda para revisión</span>
              <textarea
                rows={4}
                maxLength={1024}
                value={state.depositProofReceivedMessageTemplate}
                disabled={!state.isAdmin}
                onInput$={(_, element) =>
                  (state.depositProofReceivedMessageTemplate = element.value)
                }
              />
              <small>
                Es un acuse para casos que no se autoconfirman; no debe prometer
                que el turno ya está confirmado.
              </small>
            </label>
            <label class="form-field automation-message-field">
              <span>Confirmación de la seña</span>
              <textarea
                rows={4}
                maxLength={1024}
                value={state.depositConfirmedMessageTemplate}
                disabled={!state.isAdmin}
                onInput$={(_, element) =>
                  (state.depositConfirmedMessageTemplate = element.value)
                }
              />
              <small>
                Podés usar {"{date}"} y {"{time}"} para la fecha y hora del
                turno, y {"{address}"} para la dirección del consultorio. A los
                turnos de 13 a 17 se les agrega solo el aviso para avisar que
                llegaste a la puerta.
              </small>
            </label>
            <label class="form-field automation-message-field">
              <span>Cuando vence la reserva</span>
              <textarea
                rows={4}
                maxLength={1024}
                value={state.bookingHoldExpiredMessageTemplate}
                disabled={!state.isAdmin}
                onInput$={(_, element) =>
                  (state.bookingHoldExpiredMessageTemplate = element.value)
                }
              />
            </label>
          </div>
        </details>

        <div class="settings-policy-alert">
          <Icon name="info" size={18} />
          <span>
            <strong>Autoconfirmación básica</strong>
            <small>
              Si la lectura encuentra el monto exacto y el alias o titular
              configurado, el turno se confirma. Si no, queda para revisión
              manual. El comprobante sigue disponible y podés cancelar el turno
              si detectás un problema.
            </small>
          </span>
        </div>

        <button
          class="primary-button"
          type="button"
          disabled={
            !state.isAdmin ||
            state.iomaDurationMinutes < 5 ||
            state.iomaDurationMinutes > 480 ||
            state.privateDurationMinutes < 5 ||
            state.privateDurationMinutes > 480 ||
            state.depositAmountArs < 1 ||
            state.depositAmountArs > 100000000 ||
            state.bookingHoldMinutes < 5 ||
            state.bookingHoldMinutes > 1440 ||
            state.depositAlias.trim().length < 3 ||
            state.depositHolder.trim().length < 3 ||
            !state.automationWelcomeMessage.trim() ||
            !state.depositRequestMessageTemplate.trim() ||
            !state.depositProofReceivedMessageTemplate.trim() ||
            !state.depositConfirmedMessageTemplate.trim() ||
            !state.bookingHoldExpiredMessageTemplate.trim()
          }
          onClick$={() =>
            saveAppSettings(
              {
                deposit_enabled: state.depositEnabled,
                deposit_amount_ars: state.depositAmountArs,
                deposit_alias: state.depositAlias.trim(),
                deposit_holder: state.depositHolder.trim(),
                booking_hold_minutes: state.bookingHoldMinutes,
                ioma_duration_minutes: state.iomaDurationMinutes,
                private_duration_minutes: state.privateDurationMinutes,
                automation_welcome_message:
                  state.automationWelcomeMessage.trim(),
                deposit_request_message_template:
                  state.depositRequestMessageTemplate.trim(),
                deposit_proof_received_message_template:
                  state.depositProofReceivedMessageTemplate.trim(),
                deposit_confirmed_message_template:
                  state.depositConfirmedMessageTemplate.trim(),
                booking_hold_expired_message_template:
                  state.bookingHoldExpiredMessageTemplate.trim(),
              },
              "WhatsApp y reservas actualizados.",
            )
          }
        >
          Guardar WhatsApp y reservas
        </button>
      </section>
    </div>
  );
});
