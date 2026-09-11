import { component$, useContext } from "@qwik.dev/core";
import { Link } from "@qwik.dev/router";
import { BOT_AUTOMATION_CONTEXT } from "~/components/app/BotAutomationContext";
import { ManualHelpLink } from "~/components/app/ManualHelpLink";
import { WhatsAppEmbeddedSignup } from "~/components/settings/WhatsAppEmbeddedSignup";
import { Icon } from "~/components/ui/Icon";
import { getSupabaseClient } from "~/lib/supabase/client";
import { SETTINGS_CONTEXT } from "./SettingsContext";

/** Estado de la conexión con WhatsApp y control de envíos. */
export const WhatsAppSettings = component$(() => {
  const settings = useContext(SETTINGS_CONTEXT);
  const { state, notice } = settings;
  const botAutomation = useContext(BOT_AUTOMATION_CONTEXT);

  return (
    <section class="settings-block integration-block">
      <div>
        <h2>Estado de WhatsApp</h2>
        <p>
          Acá podés comprobar si el número está listo para recibir y enviar
          mensajes.
        </p>
        <ManualHelpLink section="whatsapp" label="¿Cómo funciona WhatsApp?" />
      </div>
      <div class="integration-summary">
        <span>
          <Icon name="message" size={20} />
        </span>
        <div>
          <strong>
            {state.whatsappStatus === "connected"
              ? state.whatsappName || "WhatsApp conectado"
              : state.whatsappStatus === "error"
                ? "Problema de conexión"
                : "WhatsApp no configurado"}
          </strong>
          <small>
            {state.whatsappPhone ||
              "Todavía no se configuró un número de Meta."}
          </small>
        </div>
        <span
          class={{
            "integration-state": true,
            off: state.whatsappStatus !== "connected",
          }}
        >
          <i />
          {state.whatsappStatus === "connected" ? "Conectado" : "Sin conectar"}
        </span>
      </div>
      <div class="whatsapp-policy-summary">
        <div>
          <span>Respuestas automáticas</span>
          <strong
            class={botAutomation.enabled !== true ? "sending-paused" : ""}
          >
            {botAutomation.enabled === null
              ? "Sin comprobar"
              : botAutomation.enabled
                ? "Activadas"
                : "Apagadas"}
          </strong>
        </div>
        <div>
          <span>Modo de prueba</span>
          <strong>{state.testMode ? "Activo" : "Inactivo"}</strong>
        </div>
        <div>
          <span>Números permitidos</span>
          <strong>{String(state.testAllowedNumberCount)}</strong>
        </div>
        <div>
          <span>Calidad</span>
          <strong
            class={`quality-rating quality-${state.whatsappQuality.toLowerCase()}`}
          >
            {state.whatsappQuality === "UNKNOWN"
              ? "Sin verificar"
              : state.whatsappQuality === "GREEN"
                ? "Buena"
                : state.whatsappQuality === "YELLOW"
                  ? "Revisar"
                  : "Con problemas"}
          </strong>
        </div>
        <div>
          <span>Envío de mensajes</span>
          <strong class={state.sendingPaused ? "sending-paused" : ""}>
            {state.sendingPaused ? "Pausados" : "Habilitados"}
          </strong>
        </div>
      </div>
      {botAutomation.enabled === false && (
        <div class="settings-policy-alert">
          <Icon name="info" size={18} />
          <span>
            <strong>Las respuestas automáticas están apagadas</strong>
            <small>
              Los mensajes seguirán llegando a Conversaciones para que puedas
              responderlos de forma manual.
            </small>
          </span>
        </div>
      )}
      {botAutomation.enabled === null && (
        <div class="settings-policy-alert" role="alert">
          <Icon name="alert" size={18} />
          <span>
            <strong>No pudimos comprobar el bot</strong>
            <small>
              Volvé a Inicio y reintentá antes de asumir que está encendido o
              apagado.
            </small>
          </span>
        </div>
      )}
      {state.testMode && state.testAllowedNumberCount === 0 && (
        <div class="settings-policy-alert" role="alert">
          <Icon name="alert" size={18} />
          <span>
            <strong>Todavía no se pueden enviar pruebas</strong>
            <small>
              Pedile a la persona que configuró WhatsApp que agregue al menos un
              número de prueba.
            </small>
          </span>
        </div>
      )}
      <div class="settings-button-row">
        <button
          class="secondary-button"
          type="button"
          disabled={!state.isAdmin}
          title={
            state.isAdmin
              ? "Verificar la cuenta de WhatsApp"
              : "Sólo una administradora puede verificar la conexión"
          }
          onClick$={async () => {
            const { data, error } = await getSupabaseClient().functions.invoke(
              "whatsapp-health",
              { method: "POST" },
            );
            if (error || !data) {
              notice.value = "No pudimos probar la conexión.";
              return;
            }
            state.whatsappStatus =
              data.status === "connected"
                ? "connected"
                : data.status === "incomplete"
                  ? "incomplete"
                  : "error";
            state.whatsappPhone = data.displayPhone ?? "";
            state.whatsappName = data.displayName ?? "";
            state.whatsappQuality = [
              "GREEN",
              "YELLOW",
              "RED",
              "UNKNOWN",
            ].includes(data.qualityRating)
              ? data.qualityRating
              : "UNKNOWN";
            state.sendingPaused = Boolean(data.sendingPaused);
            state.sendingPauseReason = data.sendingPauseReason ?? "";
            state.testMode = data.safety?.testMode !== false;
            state.testAllowedNumberCount = Number(
              data.safety?.testAllowedNumberCount ?? 0,
            );
            notice.value = data.message || "Estado actualizado.";
          }}
        >
          Verificar conexión
        </button>
        <Link class="secondary-button" href="/app/templates">
          <Icon name="file" size={17} /> Mensajes para WhatsApp
        </Link>
      </div>
      {state.isAdmin && <WhatsAppEmbeddedSignup isAdmin={state.isAdmin} />}
    </section>
  );
});
