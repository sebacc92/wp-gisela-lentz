import {
  $,
  component$,
  useComputed$,
  useContext,
  useStore,
  useVisibleTask$,
} from "@qwik.dev/core";
import { Link } from "@qwik.dev/router";
import { APP_USER_CONTEXT } from "~/components/app/AppUserContext";
import { Icon } from "~/components/ui/Icon";
import { BUSINESS_CONFIG } from "~/config/business";
import {
  describeCalendarSync,
  parseCalendarSyncOutcome,
  parseCalendarSyncSummary,
} from "~/lib/calendar-sync-summary";
import {
  googleCalendarOperationalView,
  parseGoogleCalendarOperationalStatus,
  type GoogleCalendarOperationalStatus,
} from "~/lib/google-calendar-operational-status";
import { canRunManualGoogleCalendarSync } from "~/lib/google-calendar-ui-state";
import { getSupabaseClient } from "~/lib/supabase/client";
import "./calendar-status.css";

interface GoogleCalendarStatusBlockProps {
  variant: "home" | "agenda";
}

function formatSuccessfulReview(value: string): string {
  if (!value) return "Todavía no verificada";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Todavía no verificada";
  return new Intl.DateTimeFormat("es-AR", {
    dateStyle: "short",
    timeStyle: "short",
    hourCycle: "h23",
    timeZone: BUSINESS_CONFIG.timezone,
  }).format(date);
}

export const GoogleCalendarStatusBlock =
  component$<GoogleCalendarStatusBlockProps>(({ variant }) => {
    const appUser = useContext(APP_USER_CONTEXT);
    const state = useStore<{
      status: GoogleCalendarOperationalStatus | null;
      loading: boolean;
      syncing: boolean;
      error: boolean;
      message: string;
    }>({
      status: null,
      loading: true,
      syncing: false,
      error: false,
      message: "",
    });

    const loadStatus = $(async (): Promise<boolean> => {
      if (state.loading && state.status !== null) return false;
      state.loading = true;
      try {
        const { data, error } = await getSupabaseClient().functions.invoke(
          "google-calendar-status",
          { method: "GET" },
        );
        const parsed = error
          ? null
          : parseGoogleCalendarOperationalStatus(data);
        if (!parsed) throw new Error("GOOGLE_CALENDAR_STATUS_UNAVAILABLE");
        state.status = parsed;
        state.error = false;
        state.message = "";
        return true;
      } catch {
        state.error = true;
        state.message =
          "No pudimos comprobar Google Calendar. Revisá la conexión e intentá de nuevo.";
        return false;
      } finally {
        state.loading = false;
      }
    });

    // El cliente autenticado sólo existe en navegador; esta lectura consulta
    // estado local y no inicia ninguna sincronización con Google.
    // eslint-disable-next-line qwik/no-use-visible-task
    useVisibleTask$(() => {
      void loadStatus();
    });

    const synchronize = $(async () => {
      const current = state.status;
      if (
        state.syncing ||
        state.loading ||
        !appUser.isAdmin ||
        !current ||
        !canRunManualGoogleCalendarSync(
          current.firstImportApproved,
          current.inboundSyncState,
          current.connected,
        )
      ) {
        return;
      }

      state.syncing = true;
      state.error = false;
      state.message = "";
      try {
        const { data, error } = await getSupabaseClient().functions.invoke(
          "process-calendar-sync",
          { method: "POST", body: { mode: "manual" } },
        );
        if (
          error ||
          data?.processed !== true ||
          data?.reconnectRequired === true ||
          data?.ignored === true
        ) {
          throw new Error("GOOGLE_CALENDAR_SYNC_FAILED");
        }

        const outcome = parseCalendarSyncOutcome(data?.outcome);
        const summary = parseCalendarSyncSummary(data?.summary);
        window.dispatchEvent(new Event("calendar-synchronized"));
        if (!(await loadStatus())) return;

        state.error = outcome === "error" || summary.failed > 0;
        state.message = describeCalendarSync({
          summary,
          outcome,
          checkedAt: state.status?.lastSuccessfulReviewAt || null,
          skippedReason:
            typeof data?.inbound?.skippedReason === "string"
              ? data.inbound.skippedReason
              : null,
          error:
            typeof data?.inbound?.error === "string"
              ? data.inbound.error
              : null,
        });
      } catch {
        state.error = true;
        state.message =
          "No pudimos completar la sincronización. Revisá el estado antes de volver a intentar.";
      } finally {
        state.syncing = false;
      }
    });

    const view = useComputed$(() =>
      state.status ? googleCalendarOperationalView(state.status) : null,
    );
    const canSynchronize = Boolean(
      appUser.isAdmin &&
      !state.error &&
      state.status &&
      canRunManualGoogleCalendarSync(
        state.status.firstImportApproved,
        state.status.inboundSyncState,
        state.status.connected,
      ),
    );
    const hasConflicts = (state.status?.conflictCount ?? 0) > 0;

    return (
      <section
        class={{
          "calendar-operational-status": true,
          [variant]: true,
          [view.value?.kind ?? "unknown"]: true,
          error: state.error,
        }}
        aria-label="Estado de Google Calendar"
        aria-busy={state.loading || state.syncing}
      >
        <div class="calendar-operational-heading">
          <span class="calendar-operational-icon" aria-hidden="true">
            <Icon name="calendar" size={20} />
          </span>
          <div>
            <strong>
              {state.loading && !view.value
                ? "Comprobando Google Calendar…"
                : (view.value?.title ??
                  "Estado de Google Calendar no disponible")}
            </strong>
            <small>
              {view.value?.detail ??
                "Volvé a consultar el estado antes de depender de la sincronización."}
            </small>
          </div>
        </div>

        {state.status && (
          <details class="calendar-status-disclosure">
            <summary>Detalles de sincronización</summary>
            <dl class="calendar-operational-details">
              <div>
                <dt>Automatización</dt>
                <dd>
                  {state.status.connected && state.status.automationActive
                    ? "Activa"
                    : "No activada"}
                </dd>
              </div>
              <div>
                <dt>Última revisión exitosa</dt>
                <dd>
                  {formatSuccessfulReview(state.status.lastSuccessfulReviewAt)}
                </dd>
              </div>
              <div>
                <dt>Pendientes</dt>
                <dd>{state.status.pendingCount}</dd>
              </div>
              <div>
                <dt>Para revisar</dt>
                <dd>
                  {state.status.conflictCount} conflicto(s) ·{" "}
                  {state.status.failedCount} trabajo(s) con error
                  {state.status.hasSyncError
                    ? " · última revisión fallida"
                    : ""}
                </dd>
              </div>
            </dl>
          </details>
        )}

        {state.message && (
          <p
            class="calendar-operational-feedback"
            role={state.error ? "alert" : "status"}
            aria-live={state.error ? "assertive" : "polite"}
          >
            {state.message}
          </p>
        )}

        <div class="calendar-operational-actions">
          {appUser.isAdmin && hasConflicts ? (
            <Link
              class="secondary-button small"
              href="/app/settings?section=google#google-calendar-conflicts"
            >
              Revisar cambios
            </Link>
          ) : appUser.isAdmin ? (
            <button
              class="secondary-button small"
              type="button"
              disabled={!canSynchronize || state.loading || state.syncing}
              onClick$={synchronize}
            >
              {state.syncing ? "Sincronizando…" : "Sincronizar ahora"}
            </button>
          ) : null}
          {state.error && !state.syncing ? (
            <button
              class="secondary-button small"
              type="button"
              disabled={state.loading}
              onClick$={loadStatus}
            >
              {state.loading ? "Consultando…" : "Reintentar estado"}
            </button>
          ) : (
            <Link
              class="calendar-operational-link"
              href="/app/settings?section=google"
            >
              Ver configuración
            </Link>
          )}
        </div>
      </section>
    );
  });
