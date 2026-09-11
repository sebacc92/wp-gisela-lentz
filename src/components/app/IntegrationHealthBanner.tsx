import {
  $,
  component$,
  useContext,
  useSignal,
  useStore,
  useVisibleTask$,
} from "@qwik.dev/core";
import { Link } from "@qwik.dev/router";
import { APP_USER_CONTEXT } from "~/components/app/AppUserContext";
import { Icon } from "~/components/ui/Icon";
import {
  integrationHealthAlerts,
  type IntegrationHealthAlert,
  type WhatsAppHealthInput,
} from "~/lib/integration-health";
import { getSupabaseClient } from "~/lib/supabase/client";
import "./integration-health.css";

/**
 * Aviso de integraciones caídas. Sólo lee estado ya guardado: abrir el inicio
 * nunca dispara tráfico hacia Meta ni hacia Google, que es justamente lo que
 * no conviene hacer cuando una integración puede estar en problemas.
 */
export const IntegrationHealthBanner = component$(() => {
  const appUser = useContext(APP_USER_CONTEXT);
  const dismissed = useSignal<string[]>([]);
  const state = useStore<{ alerts: IntegrationHealthAlert[]; loaded: boolean }>(
    { alerts: [], loaded: false },
  );

  const load = $(async () => {
    const whatsapp: WhatsAppHealthInput = {
      integrationStatus: null,
      lastError: null,
      sendingPaused: null,
      sendingPauseReason: null,
    };

    const settingsResult = await getSupabaseClient()
      .from("whatsapp_settings")
      .select(
        "integration_status,last_error,sending_paused,sending_pause_reason",
      )
      .eq("id", true)
      .maybeSingle();

    const row = settingsResult.error ? null : settingsResult.data;
    if (row) {
      const status = row.integration_status;
      whatsapp.integrationStatus =
        status === "connected" || status === "error" || status === "incomplete"
          ? status
          : null;
      whatsapp.lastError =
        typeof row.last_error === "string" ? row.last_error : null;
      whatsapp.sendingPaused =
        typeof row.sending_paused === "boolean" ? row.sending_paused : null;
      whatsapp.sendingPauseReason =
        typeof row.sending_pause_reason === "string"
          ? row.sending_pause_reason
          : null;
    }

    // Calendar no se evalúa acá: el bloque de Calendar del inicio ya lo cubre.
    state.alerts = integrationHealthAlerts({ whatsapp });
    state.loaded = true;
  });

  // Lectura local de estado ya persistido; no inicia ninguna integración.
  // eslint-disable-next-line qwik/no-use-visible-task
  useVisibleTask$(() => {
    void load();
  });

  const visible = state.alerts.filter(
    (alert) => !dismissed.value.includes(alert.id),
  );
  if (!state.loaded || visible.length === 0) return null;

  return (
    <div class="integration-health">
      {visible.map((alert) => (
        <section
          key={alert.id}
          class={`integration-health-alert ${alert.severity}`}
          role={alert.severity === "critical" ? "alert" : "status"}
        >
          <span class="integration-health-icon" aria-hidden="true">
            <Icon
              name={alert.severity === "critical" ? "alert" : "info"}
              size={19}
            />
          </span>
          <div class="integration-health-copy">
            <strong>{alert.title}</strong>
            <small>{alert.detail}</small>
          </div>
          <div class="integration-health-actions">
            {(!alert.adminOnly || appUser.isAdmin) && (
              <Link class="secondary-button small" href={alert.actionHref}>
                {alert.actionLabel}
              </Link>
            )}
            <button
              class="integration-health-dismiss"
              type="button"
              aria-label={`Ocultar el aviso: ${alert.title}`}
              onClick$={() => {
                dismissed.value = [...dismissed.value, alert.id];
              }}
            >
              <Icon name="x" size={16} />
            </button>
          </div>
        </section>
      ))}
    </div>
  );
});
