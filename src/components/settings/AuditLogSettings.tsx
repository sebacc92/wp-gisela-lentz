import {
  $,
  component$,
  useContext,
  useSignal,
  useStore,
  useVisibleTask$,
} from "@qwik.dev/core";
import { Icon } from "~/components/ui/Icon";
import {
  auditTone,
  describeAuditAction,
  summarizeAuditMetadata,
  webhookTone,
} from "~/lib/audit-view";
import { formatBusinessDate } from "~/lib/date-time";
import {
  loadAuditLogs,
  loadWebhookEvents,
  type AuditLogEntry,
  type WebhookEventEntry,
} from "~/lib/supabase/audit";
import { getSupabaseClient } from "~/lib/supabase/client";
import { SETTINGS_CONTEXT } from "./SettingsContext";
import "./audit-log.css";

function when(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return formatBusinessDate(date, { dateStyle: "short", timeStyle: "short" });
}

/**
 * Visor de actividad de las integraciones.
 *
 * Muestra lo que el navegador puede leer de verdad: la auditoría de acciones y
 * los eventos de webhook que llegaron de Meta. Las colas internas y los logs
 * de las edge functions son de `service_role`, así que no se consultan desde
 * acá; el panel lo dice en lugar de fingir que no hubo actividad.
 */
export const AuditLogSettings = component$(() => {
  const settings = useContext(SETTINGS_CONTEXT);
  const view = useSignal<"audit" | "webhooks">("audit");
  const reloadVersion = useSignal(0);
  const state = useStore<{
    audit: AuditLogEntry[];
    webhooks: WebhookEventEntry[];
    loading: boolean;
    error: string;
  }>({ audit: [], webhooks: [], loading: true, error: "" });

  const load = $(async () => {
    state.loading = true;
    state.error = "";
    try {
      const client = getSupabaseClient();
      const [audit, webhooks] = await Promise.all([
        loadAuditLogs(client),
        loadWebhookEvents(client),
      ]);
      state.audit = audit;
      state.webhooks = webhooks;
    } catch {
      state.error =
        "No pudimos leer el registro. Sólo una persona administradora puede verlo.";
    } finally {
      state.loading = false;
    }
  });

  // eslint-disable-next-line qwik/no-use-visible-task
  useVisibleTask$(({ track }) => {
    track(() => reloadVersion.value);
    void load();
  });

  if (!settings.state.isAdmin) {
    return (
      <section class="settings-block">
        <div>
          <h2>Registro de actividad</h2>
          <p>Sólo una persona administradora puede ver el registro.</p>
        </div>
      </section>
    );
  }

  return (
    <section class="settings-block audit-log">
      <div>
        <h2>Registro de actividad</h2>
        <p>
          Últimas acciones registradas y eventos recibidos de Meta. Es sólo
          lectura: sirve para revisar qué pasó y cuándo.
        </p>
      </div>

      <div class="audit-log-toolbar">
        <div class="simple-tabs" role="tablist" aria-label="Tipo de registro">
          <button
            type="button"
            role="tab"
            class={{ active: view.value === "audit" }}
            aria-selected={view.value === "audit"}
            onClick$={() => (view.value = "audit")}
          >
            Acciones ({state.audit.length})
          </button>
          <button
            type="button"
            role="tab"
            class={{ active: view.value === "webhooks" }}
            aria-selected={view.value === "webhooks"}
            onClick$={() => (view.value = "webhooks")}
          >
            Webhooks ({state.webhooks.length})
          </button>
        </div>
        <button
          class="secondary-button small"
          type="button"
          disabled={state.loading}
          onClick$={() => (reloadVersion.value += 1)}
        >
          {state.loading ? "Actualizando…" : "Actualizar"}
        </button>
      </div>

      {state.loading ? (
        <div class="section-empty" role="status">
          <span class="small-spinner" aria-hidden="true" />
          <p>Leyendo el registro…</p>
        </div>
      ) : state.error ? (
        <div class="section-empty" role="alert">
          <Icon name="alert" size={22} />
          <p>{state.error}</p>
        </div>
      ) : view.value === "audit" ? (
        state.audit.length === 0 ? (
          <p class="audit-log-empty">Todavía no hay acciones registradas.</p>
        ) : (
          <ol class="audit-log-list">
            {state.audit.map((entry) => {
              const summary = summarizeAuditMetadata(entry.metadata);
              return (
                <li key={entry.id} class={`tone-${auditTone(entry.action)}`}>
                  <div class="audit-log-main">
                    <strong>{describeAuditAction(entry.action)}</strong>
                    <small>
                      {entry.actorName ?? "Automatización"} · {entry.entityType}
                      {summary ? ` · ${summary}` : ""}
                    </small>
                  </div>
                  <time dateTime={entry.createdAt}>
                    {when(entry.createdAt)}
                  </time>
                </li>
              );
            })}
          </ol>
        )
      ) : state.webhooks.length === 0 ? (
        <p class="audit-log-empty">Todavía no llegaron eventos de Meta.</p>
      ) : (
        <ol class="audit-log-list">
          {state.webhooks.map((event) => (
            <li key={event.id} class={`tone-${webhookTone(event.status)}`}>
              <div class="audit-log-main">
                <strong>{event.eventType}</strong>
                <small>
                  {event.status}
                  {event.error ? ` · ${event.error}` : ""}
                  {event.processedAt
                    ? ` · procesado ${when(event.processedAt)}`
                    : " · sin procesar"}
                </small>
              </div>
              <time dateTime={event.createdAt}>{when(event.createdAt)}</time>
            </li>
          ))}
        </ol>
      )}

      <p class="audit-log-note">
        Las colas internas y la ejecución de las edge functions no se pueden
        leer desde el navegador: quedan en los registros de Supabase.
      </p>
    </section>
  );
});
