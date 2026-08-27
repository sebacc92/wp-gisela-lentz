import { component$, type QRL } from "@qwik.dev/core";
import type { ManualStatusCard } from "~/lib/manual-status";
import { Icon } from "../ui/Icon";

export interface ManualSystemStatus {
  whatsapp: ManualStatusCard;
  automation: ManualStatusCard;
  testMode: ManualStatusCard;
  calendar: ManualStatusCard;
  webhook: ManualStatusCard;
  lastWebhookAt: string;
  refreshedAt: string;
  loading: boolean;
  error: boolean;
}

interface SystemStatusProps {
  status: ManualSystemStatus;
  onRefresh$: QRL<() => Promise<void>>;
}

function iconForTone(tone: ManualStatusCard["tone"]) {
  return tone === "good"
    ? "check-circle"
    : tone === "attention"
      ? "alert"
      : tone === "pending"
        ? "clock"
        : "info";
}

function formatDate(value: string): string {
  if (!value) return "Todavía no disponible";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Todavía no disponible";
  return new Intl.DateTimeFormat("es-AR", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/Argentina/Buenos_Aires",
  }).format(date);
}

export const SystemStatus = component$<SystemStatusProps>(
  ({ status, onRefresh$ }) => {
    const cards = [
      status.whatsapp,
      status.automation,
      status.testMode,
      status.calendar,
      status.webhook,
    ];

    return (
      <section id="estado-del-sistema" class="manual-section">
        <div class="manual-section-heading">
          <div>
            <span class="eyebrow">Estado del sistema</span>
            <h2>Lo importante, de un vistazo</h2>
            <p>
              Estos avisos no muestran claves ni datos técnicos. Si algo no se
              puede comprobar, lo indicamos claramente.
            </p>
          </div>
          <button
            class="secondary-button"
            type="button"
            disabled={status.loading}
            onClick$={() => onRefresh$()}
          >
            {status.loading ? "Actualizando…" : "Actualizar estado"}
          </button>
        </div>

        {status.error && (
          <p class="manual-status-notice" role="alert">
            No pudimos actualizar todo el estado. Revisá la conexión e intentá
            de nuevo antes de tomar una decisión.
          </p>
        )}

        <div class="system-status-grid" aria-live="polite">
          {cards.map((card) => (
            <article key={card.title} class={`system-status-card ${card.tone}`}>
              <span class="system-status-icon" aria-hidden="true">
                <Icon name={iconForTone(card.tone)} size={20} />
              </span>
              <div>
                <h3>{card.title}</h3>
                <p>{card.detail}</p>
              </div>
            </article>
          ))}
        </div>

        <dl class="manual-status-details">
          <div>
            <dt>Última novedad de WhatsApp</dt>
            <dd>{formatDate(status.lastWebhookAt)}</dd>
          </div>
          <div>
            <dt>Última actualización de esta pantalla</dt>
            <dd>{formatDate(status.refreshedAt)}</dd>
          </div>
        </dl>
      </section>
    );
  },
);
