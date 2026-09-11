import {
  $,
  component$,
  useContext,
  useStore,
  useVisibleTask$,
} from "@qwik.dev/core";
import { useLocation } from "@qwik.dev/router";
import { ManualHelpLink } from "~/components/app/ManualHelpLink";
import { Icon } from "~/components/ui/Icon";
import {
  describeCalendarSync,
  parseCalendarSyncOutcome,
  parseCalendarSyncSummary,
} from "~/lib/calendar-sync-summary";
import {
  describeCalendarConflictReviewBlock,
  parseCalendarConflictReview,
  type CalendarConflictReview,
} from "~/lib/google-calendar-conflict-review";
import {
  parseCalendarImportPreview,
  sameCalendarImportPreview,
  type CalendarImportPreview,
} from "~/lib/google-calendar-import-preview";
import {
  canRunManualGoogleCalendarSync,
  googleCalendarSyncStatus,
  type GoogleCalendarSyncStatus,
} from "~/lib/google-calendar-ui-state";
import { getSupabaseClient } from "~/lib/supabase/client";
import {
  loadCalendarConflicts,
  type CalendarConflict,
} from "~/lib/supabase/data";
import { SETTINGS_CONTEXT } from "./SettingsContext";
import { formatLastCalendarSync, formatSettingsDate } from "./settings-format";
import type { SelectableGoogleCalendar } from "./settings-types";

const GOOGLE_CALENDAR_SELECTION_REQUIRED_MESSAGE =
  "Google ya autorizó la cuenta. Ahora elegí qué calendario querés sincronizar.";

async function googleCalendarFunctionErrorCode(
  data: unknown,
  error: unknown,
): Promise<string> {
  const codeFrom = (value: unknown): string => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return "";
    const code = (value as Record<string, unknown>).error;
    return typeof code === "string" ? code : "";
  };

  const directCode = codeFrom(data);
  if (directCode) return directCode;
  if (!error || typeof error !== "object" || Array.isArray(error)) return "";

  const context = (error as Record<string, unknown>).context;
  const contextCode = codeFrom(context);
  if (contextCode) return contextCode;
  if (!(context instanceof Response)) return "";

  try {
    return codeFrom(await context.clone().json());
  } catch {
    return "";
  }
}

function describeGoogleCalendarSelectionError(code: string): string {
  switch (code) {
    case "GOOGLE_CALENDAR_TIMEZONE_MISMATCH":
      return "Ese calendario usa otra zona horaria. Elegí uno que coincida con la agenda.";
    case "GOOGLE_CALENDAR_EVENTS_ACCESS_REQUIRED":
      return "Google no otorgó el permiso para administrar eventos. Elegí otra cuenta y aceptá ambos permisos.";
    case "GOOGLE_CALENDAR_DISCONNECT_REQUIRED":
      return "Primero desconectá la cuenta actual y después conectá la cuenta nueva.";
    case "GOOGLE_CALENDAR_OWNER_REQUIRED":
      return "Ese calendario no es propio. Elegí uno del que seas propietaria.";
    case "GOOGLE_CALENDAR_SELECTION_EXPIRED":
    case "GOOGLE_CALENDAR_SELECTION_NOT_PENDING":
    case "GOOGLE_RECONNECT_REQUIRED":
      return "La autorización ya no está vigente. Elegí otra cuenta y volvé a conectarla.";
    default:
      return "No pudimos confirmar el calendario. No cambiamos la sincronización actual.";
  }
}

function parseSelectableGoogleCalendars(
  value: unknown,
): SelectableGoogleCalendar[] {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  const calendars: SelectableGoogleCalendar[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const candidate = entry as Record<string, unknown>;
    const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
    const name =
      typeof candidate.name === "string" ? candidate.name.trim() : "";
    if (!id || !name || seen.has(id)) continue;

    seen.add(id);
    calendars.push({
      id,
      name,
      primary: candidate.primary === true,
      timeZone:
        typeof candidate.timeZone === "string" ? candidate.timeZone.trim() : "",
    });
  }
  return calendars;
}

/**
 * Conexión y sincronización con Google Calendar.
 *
 * Es la sección más grande de Configuración y la única con estado propio: el
 * resto de las pestañas comparte `SETTINGS_CONTEXT`, pero acá el estado de la
 * conexión, la vista previa de importación y los conflictos sólo importan
 * mientras esta pestaña está abierta. Al montarse consulta el estado; al
 * cerrarse lo suelta, así nunca se muestra una sincronización vieja.
 */
export const GoogleCalendarSettings = component$(() => {
  const settings = useContext(SETTINGS_CONTEXT);
  const { state } = settings;
  const location = useLocation();
  const googleResult =
    location.url.searchParams.get("google") ??
    location.url.searchParams.get("google_calendar");

  const googleCalendar = useStore({
    configured: true,
    connected: false,
    selectionPending: googleResult === "selection_required",
    email: "",
    calendarName: "",
    selectableCalendars: [] as SelectableGoogleCalendar[],
    selectableCalendarsLoaded: false,
    selectableCalendarsError: "",
    selectedCalendarId: "",
    syncStatus: "synced" as GoogleCalendarSyncStatus,
    lastSyncedAt: "",
    lastCheckedAt: "",
    lastSyncCompletedAt: "",
    automationActive: false,
    lastSyncError: "",
    inboundSyncState: "",
    firstImportApproved: false,
    pendingCount: 0,
    failedCount: 0,
    blockCount: 0,
    unsupportedCount: 0,
    conflictCount: 0,
    conflicts: [] as CalendarConflict[],
    conflictsError: "",
    preview: null as CalendarImportPreview | null,
    loaded: false,
    loading: false,
    action: "" as
      | ""
      | "connect"
      | "sync"
      | "disconnect"
      | "preview"
      | "approve"
      | "load-calendars"
      | "select-calendar"
      | "cancel-selection",
    resolving: "",
    resolvingAction: "" as "" | "reject" | "apply" | "review" | "accept-title",
    conflictReview: null as CalendarConflictReview | null,
    conflictReviewConfirmed: false,
    message:
      googleResult === "selection_required"
        ? GOOGLE_CALENDAR_SELECTION_REQUIRED_MESSAGE
        : googleResult === "connected"
          ? "Google Calendar quedó conectado. Estamos comprobando que todo esté al día."
          : googleResult === "denied" || googleResult === "cancelled"
            ? "No se completó la conexión. Podés intentarlo nuevamente cuando quieras."
            : googleResult === "error"
              ? "No pudimos conectar Google Calendar. Probá otra vez."
              : "",
    error: googleResult === "error",
  });

  const loadGoogleCalendarStatus = $(async (): Promise<boolean> => {
    googleCalendar.conflictReview = null;
    googleCalendar.conflictReviewConfirmed = false;
    googleCalendar.loading = true;
    googleCalendar.error = false;
    try {
      const { data, error } = await getSupabaseClient().functions.invoke(
        "google-calendar-status",
        { method: "GET" },
      );
      if (error || !data) throw new Error("GOOGLE_CALENDAR_STATUS_FAILED");

      googleCalendar.configured = data.configured !== false;
      googleCalendar.connected = Boolean(data.connected);
      googleCalendar.selectionPending =
        data.selectionPending === true || data.status === "selection_required";
      if (
        !googleCalendar.selectionPending &&
        googleCalendar.message === GOOGLE_CALENDAR_SELECTION_REQUIRED_MESSAGE
      ) {
        googleCalendar.message = "";
      }
      googleCalendar.email = typeof data.email === "string" ? data.email : "";
      googleCalendar.calendarName =
        typeof data.calendarName === "string" ? data.calendarName : "";
      const lastCheckedAt =
        typeof data.lastCheckedAt === "string" ? data.lastCheckedAt : "";
      const lastSyncCompletedAt =
        typeof data.lastSyncCompletedAt === "string"
          ? data.lastSyncCompletedAt
          : "";
      const inboundSyncState =
        typeof data.inboundSyncState === "string" ? data.inboundSyncState : "";
      const firstImportApproved = data.firstImportApproved === true;
      googleCalendar.lastCheckedAt = lastCheckedAt;
      googleCalendar.lastSyncCompletedAt = lastSyncCompletedAt;
      googleCalendar.automationActive = data.automationActive === true;
      googleCalendar.lastSyncError =
        typeof data.lastSyncError === "string" ? data.lastSyncError : "";
      googleCalendar.inboundSyncState = inboundSyncState;
      googleCalendar.firstImportApproved = firstImportApproved;
      googleCalendar.syncStatus = googleCalendarSyncStatus({
        status: data.status,
        firstImportApproved,
        inboundSyncState,
        lastSyncCompletedAt,
        automationActive: googleCalendar.automationActive,
      });
      googleCalendar.blockCount = Number(data.blockCount ?? 0);
      googleCalendar.unsupportedCount = Number(data.unsupportedCount ?? 0);
      googleCalendar.conflictCount = Number(data.conflictCount ?? 0);
      googleCalendar.conflictsError = "";
      if (googleCalendar.conflictCount > 0) {
        try {
          googleCalendar.conflicts =
            await loadCalendarConflicts(getSupabaseClient());
        } catch {
          googleCalendar.conflicts = [];
          googleCalendar.conflictsError =
            "Hay cambios pendientes, pero no pudimos cargar el detalle. Probá nuevamente antes de tomar una decisión.";
        }
      } else {
        googleCalendar.conflicts = [];
      }
      googleCalendar.lastSyncedAt =
        typeof data.lastSyncedAt === "string" ? data.lastSyncedAt : "";
      googleCalendar.pendingCount = Number(data.pendingCount ?? 0);
      googleCalendar.failedCount = Number(data.failedCount ?? 0);
      if (!googleCalendar.selectionPending) {
        googleCalendar.selectableCalendars = [];
        googleCalendar.selectableCalendarsLoaded = false;
        googleCalendar.selectableCalendarsError = "";
        googleCalendar.selectedCalendarId = "";
      }
      if (!googleCalendar.message && typeof data.message === "string") {
        googleCalendar.message = data.message;
      }
      googleCalendar.loaded = true;
      return true;
    } catch {
      googleCalendar.error = true;
      googleCalendar.message =
        "No pudimos consultar Google Calendar. Revisá tu conexión e intentá otra vez.";
      return false;
    } finally {
      googleCalendar.loading = false;
    }
  });

  const reviewImportedCalendarConflict = $(async (conflictId: string) => {
    if (
      !state.isAdmin ||
      googleCalendar.loading ||
      Boolean(googleCalendar.action) ||
      Boolean(googleCalendar.resolving) ||
      !googleCalendar.conflicts.some(
        (item) =>
          item.id === conflictId &&
          item.imported &&
          item.kind === "metadata_changed",
      )
    )
      return;
    googleCalendar.resolving = conflictId;
    googleCalendar.resolvingAction = "review";
    googleCalendar.conflictReview = null;
    googleCalendar.conflictReviewConfirmed = false;
    googleCalendar.error = false;
    googleCalendar.message = "";
    try {
      const { data, error } = await getSupabaseClient().functions.invoke(
        "google-calendar-conflict-review",
        { body: { action: "review", conflictId } },
      );
      const review = parseCalendarConflictReview(data, conflictId);
      if (error || !review) throw new Error("CALENDAR_CONFLICT_REVIEW_FAILED");
      googleCalendar.conflictReview = review;
    } catch {
      const refreshed = await loadGoogleCalendarStatus();
      googleCalendar.error = true;
      googleCalendar.message = refreshed
        ? "No pudimos revisar el cambio. No aceptamos nada: volvé a tocar «Revisar cambio» para intentarlo nuevamente."
        : "No pudimos revisar el cambio ni actualizar el estado. No aceptamos nada: recargá esta sección antes de continuar.";
    } finally {
      googleCalendar.resolving = "";
      googleCalendar.resolvingAction = "";
    }
  });

  const acceptImportedCalendarTitle = $(async (conflictId: string) => {
    const review = googleCalendar.conflictReview;
    if (
      !state.isAdmin ||
      googleCalendar.loading ||
      Boolean(googleCalendar.action) ||
      Boolean(googleCalendar.resolving) ||
      !googleCalendar.conflictReviewConfirmed ||
      !review ||
      review.conflictId !== conflictId ||
      !review.canAcceptTitle ||
      !review.reviewToken
    )
      return;
    googleCalendar.resolving = conflictId;
    googleCalendar.resolvingAction = "accept-title";
    googleCalendar.error = false;
    googleCalendar.message = "";
    // An uncertain response must require a fresh review, never token reuse.
    googleCalendar.conflictReview = null;
    googleCalendar.conflictReviewConfirmed = false;
    try {
      const { data, error } = await getSupabaseClient().functions.invoke(
        "google-calendar-conflict-review",
        {
          body: {
            action: "accept_title",
            conflictId,
            reviewToken: review.reviewToken,
          },
        },
      );
      if (error || data?.resolved !== true)
        throw new Error("CALENDAR_CONFLICT_ACCEPT_FAILED");
      const refreshed = await loadGoogleCalendarStatus();
      googleCalendar.error = !refreshed;
      googleCalendar.message = refreshed
        ? "Aceptamos el texto de Google. No cambiamos el paciente ni el horario y no escribimos en Google Calendar. Aceptar el texto no registra pagos ni confirma una seña."
        : "La aceptación se guardó, pero no pudimos actualizar la vista. Recargá esta sección antes de continuar.";
    } catch {
      const refreshed = await loadGoogleCalendarStatus();
      googleCalendar.error = true;
      googleCalendar.message = refreshed
        ? "No pudimos confirmar la aceptación. Revisá el estado; si el cambio sigue pendiente, tocá «Revisar cambio» otra vez antes de decidir."
        : "No pudimos confirmar la aceptación ni actualizar el estado. Recargá esta sección antes de continuar.";
    } finally {
      googleCalendar.resolving = "";
      googleCalendar.resolvingAction = "";
    }
  });

  const loadSelectableGoogleCalendars = $(async () => {
    if (
      !state.isAdmin ||
      !googleCalendar.selectionPending ||
      Boolean(googleCalendar.action) ||
      Boolean(googleCalendar.resolving)
    ) {
      return;
    }

    googleCalendar.action = "load-calendars";
    googleCalendar.selectableCalendarsError = "";
    try {
      const { data, error } = await getSupabaseClient().functions.invoke(
        "google-calendar-selection",
        { method: "GET" },
      );
      if (!error && data?.selectionRequired === false) {
        googleCalendar.selectionPending = false;
        googleCalendar.selectableCalendars = [];
        googleCalendar.selectableCalendarsLoaded = false;
        googleCalendar.selectableCalendarsError = "";
        googleCalendar.selectedCalendarId = "";
        await loadGoogleCalendarStatus();
        return;
      }
      if (error || !Array.isArray(data?.calendars)) {
        throw new Error("GOOGLE_CALENDAR_LIST_FAILED");
      }

      googleCalendar.selectableCalendars = parseSelectableGoogleCalendars(
        data.calendars,
      );
      googleCalendar.selectableCalendarsLoaded = true;
      if (
        !googleCalendar.selectableCalendars.some(
          (calendar) => calendar.id === googleCalendar.selectedCalendarId,
        )
      ) {
        googleCalendar.selectedCalendarId = "";
      }
    } catch {
      googleCalendar.selectableCalendars = [];
      googleCalendar.selectableCalendarsLoaded = false;
      googleCalendar.selectableCalendarsError =
        "No pudimos cargar tus calendarios. Probá nuevamente.";
    } finally {
      googleCalendar.action = "";
    }
  });

  const cancelGoogleCalendarSelection = $(async () => {
    if (
      !state.isAdmin ||
      Boolean(googleCalendar.action) ||
      Boolean(googleCalendar.resolving)
    )
      return;

    googleCalendar.action = "cancel-selection";
    googleCalendar.error = false;
    googleCalendar.message = "";
    try {
      const { data, error } = await getSupabaseClient().functions.invoke(
        "google-calendar-selection",
        { method: "DELETE" },
      );
      if (error || data?.cancelled !== true) {
        throw new Error("GOOGLE_CALENDAR_SELECTION_CANCEL_FAILED");
      }

      googleCalendar.selectionPending = false;
      googleCalendar.selectableCalendars = [];
      googleCalendar.selectableCalendarsLoaded = false;
      googleCalendar.selectableCalendarsError = "";
      googleCalendar.selectedCalendarId = "";
      await loadGoogleCalendarStatus();
      googleCalendar.message = googleCalendar.connected
        ? "Descartamos la selección. El calendario conectado no cambió."
        : "Descartamos la selección. Ya podés conectar la cuenta correcta.";
    } catch {
      googleCalendar.error = true;
      googleCalendar.message =
        "No pudimos descartar la selección. Probá nuevamente.";
    } finally {
      googleCalendar.action = "";
    }
  });

  // Al abrir la pestaña se consulta el estado real; si Google dejó una
  // selección a medias, se ofrece elegir calendario.
  // eslint-disable-next-line qwik/no-use-visible-task
  useVisibleTask$(async () => {
    await loadGoogleCalendarStatus();
    if (state.isAdmin && googleCalendar.selectionPending) {
      await loadSelectableGoogleCalendars();
    }
  });

  return (
    <section
      class="settings-block google-calendar-settings"
      aria-busy={googleCalendar.loading || Boolean(googleCalendar.action)}
    >
      <div>
        <h2>Google Calendar</h2>
        <p>
          {state.isAdmin
            ? "Conectá una cuenta una sola vez para ver también los turnos confirmados del consultorio en Google Calendar."
            : "Acá podés comprobar si los turnos confirmados se están copiando a Google Calendar. La conexión la prepara la persona administradora."}
        </p>
        <ManualHelpLink
          section="calendario"
          label="¿Cómo se sincroniza el calendario?"
        />
      </div>

      {googleCalendar.message && (
        <div
          class={{
            "google-calendar-feedback": true,
            error: googleCalendar.error,
          }}
          role={googleCalendar.error ? "alert" : "status"}
          aria-live={googleCalendar.error ? "assertive" : "polite"}
        >
          <Icon name={googleCalendar.error ? "alert" : "info"} size={19} />
          <span>{googleCalendar.message}</span>
        </div>
      )}

      {googleCalendar.loading && !googleCalendar.loaded ? (
        <div class="google-calendar-loading" role="status" aria-live="polite">
          <span class="small-spinner" />
          <span>Comprobando la conexión…</span>
        </div>
      ) : googleCalendar.selectionPending && state.isAdmin ? (
        <div class="google-calendar-card google-calendar-selection">
          <div class="google-calendar-card-heading">
            <span class="google-calendar-icon">
              <Icon name="calendar" size={25} />
            </span>
            <span>
              <strong>Elegí el calendario del consultorio</strong>
              <small>
                Google ya autorizó la cuenta. Falta confirmar dónde se van a
                sincronizar los turnos.
              </small>
            </span>
            <span class="google-calendar-state pending" role="status">
              <i />
              Falta confirmar
            </span>
          </div>

          <p class="google-calendar-selection-intro">
            Seleccioná uno de los calendarios que administrás. La sincronización
            actual no cambia hasta que confirmes, para evitar mezclar agendas.
          </p>

          {googleCalendar.action === "load-calendars" ? (
            <div
              class="google-calendar-loading"
              role="status"
              aria-live="polite"
            >
              <span class="small-spinner" />
              <span>Cargando tus calendarios…</span>
            </div>
          ) : googleCalendar.selectableCalendarsError ? (
            <div class="google-calendar-selection-retry">
              <div class="google-calendar-feedback error" role="alert">
                <Icon name="alert" size={19} />
                <span>{googleCalendar.selectableCalendarsError}</span>
              </div>
              <button
                class="secondary-button"
                type="button"
                disabled={
                  Boolean(googleCalendar.action) ||
                  Boolean(googleCalendar.resolving)
                }
                onClick$={loadSelectableGoogleCalendars}
              >
                Volver a intentar
              </button>
            </div>
          ) : googleCalendar.selectableCalendarsLoaded ? (
            googleCalendar.selectableCalendars.length > 0 ? (
              <fieldset class="google-calendar-choice-fieldset">
                <legend>Calendarios disponibles</legend>
                <ul class="google-calendar-choice-list">
                  {googleCalendar.selectableCalendars.map((calendar) => (
                    <li key={calendar.id}>
                      <label
                        class={{
                          selected:
                            googleCalendar.selectedCalendarId === calendar.id,
                          incompatible: calendar.timeZone !== state.timezone,
                        }}
                      >
                        <input
                          type="radio"
                          name="google-calendar-choice"
                          disabled={calendar.timeZone !== state.timezone}
                          checked={
                            googleCalendar.selectedCalendarId === calendar.id
                          }
                          onChange$={() => {
                            googleCalendar.selectedCalendarId = calendar.id;
                          }}
                        />
                        <span>
                          <span class="google-calendar-choice-name">
                            <strong>{calendar.name}</strong>
                            {calendar.primary && <small>Principal</small>}
                          </span>
                          <small>
                            {calendar.timeZone
                              ? calendar.timeZone === state.timezone
                                ? `Zona horaria: ${calendar.timeZone}`
                                : `Zona horaria: ${calendar.timeZone} · No coincide con la agenda`
                              : "Zona horaria no informada"}
                          </small>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </fieldset>
            ) : (
              <div class="google-calendar-feedback error" role="alert">
                <Icon name="alert" size={19} />
                <span>
                  No encontramos un calendario que esta cuenta pueda
                  administrar.
                </span>
              </div>
            )
          ) : (
            <button
              class="secondary-button google-calendar-load-button"
              type="button"
              disabled={
                Boolean(googleCalendar.action) ||
                Boolean(googleCalendar.resolving)
              }
              onClick$={loadSelectableGoogleCalendars}
            >
              Cargar calendarios
            </button>
          )}

          <div class="google-calendar-actions">
            <button
              class="secondary-button"
              type="button"
              disabled={
                Boolean(googleCalendar.action) ||
                Boolean(googleCalendar.resolving)
              }
              onClick$={cancelGoogleCalendarSelection}
            >
              {googleCalendar.action === "cancel-selection"
                ? "Descartando…"
                : "Elegir otra cuenta"}
            </button>
            {googleCalendar.selectableCalendars.length > 0 && (
              <button
                class="primary-button"
                type="button"
                disabled={
                  !googleCalendar.selectedCalendarId ||
                  Boolean(googleCalendar.action) ||
                  Boolean(googleCalendar.resolving)
                }
                onClick$={async () => {
                  if (
                    !state.isAdmin ||
                    Boolean(googleCalendar.action) ||
                    Boolean(googleCalendar.resolving)
                  ) {
                    return;
                  }
                  const selectedCalendar =
                    googleCalendar.selectableCalendars.find(
                      (calendar) =>
                        calendar.id === googleCalendar.selectedCalendarId,
                    );
                  if (!selectedCalendar) return;

                  googleCalendar.action = "select-calendar";
                  googleCalendar.error = false;
                  googleCalendar.message = "";
                  try {
                    const { data, error } =
                      await getSupabaseClient().functions.invoke(
                        "google-calendar-selection",
                        {
                          method: "POST",
                          body: {
                            calendarId: googleCalendar.selectedCalendarId,
                          },
                        },
                      );
                    if (
                      error ||
                      data?.selected !== true ||
                      data?.connected !== true
                    ) {
                      const failureCode = await googleCalendarFunctionErrorCode(
                        data,
                        error,
                      );
                      throw new Error(
                        failureCode || "GOOGLE_CALENDAR_SELECTION_FAILED",
                      );
                    }

                    googleCalendar.connected = true;
                    googleCalendar.selectionPending = false;
                    googleCalendar.calendarName =
                      typeof data.calendarName === "string"
                        ? data.calendarName
                        : selectedCalendar.name;
                    googleCalendar.selectableCalendars = [];
                    googleCalendar.selectableCalendarsLoaded = false;
                    googleCalendar.selectableCalendarsError = "";
                    googleCalendar.selectedCalendarId = "";
                    googleCalendar.preview = null;
                    googleCalendar.message =
                      "Calendario confirmado. Ya podés revisar la importación inicial antes de sincronizar.";
                    await loadGoogleCalendarStatus();
                  } catch (error) {
                    googleCalendar.error = true;
                    googleCalendar.message =
                      describeGoogleCalendarSelectionError(
                        error instanceof Error ? error.message : "",
                      );
                  } finally {
                    googleCalendar.action = "";
                  }
                }}
              >
                {googleCalendar.action === "select-calendar"
                  ? "Confirmando…"
                  : "Confirmar calendario"}
              </button>
            )}
          </div>
        </div>
      ) : googleCalendar.connected ||
        googleCalendar.syncStatus === "reconnect" ? (
        <div class="google-calendar-card">
          <div class="google-calendar-card-heading">
            <span class="google-calendar-icon">
              <Icon name="calendar" size={25} />
            </span>
            <span>
              <strong>Calendario conectado</strong>
              <small>
                {googleCalendar.automationActive
                  ? "Las pre-reservas vigentes, los turnos confirmados y sus cambios se copian automáticamente en pocos minutos."
                  : "Google Calendar está conectado, pero todavía no se hacen escrituras automáticas."}
              </small>
            </span>
            <span
              class={{
                "google-calendar-state": true,
                pending:
                  googleCalendar.syncStatus === "pending" ||
                  googleCalendar.syncStatus === "inactive" ||
                  googleCalendar.syncStatus === "first_import" ||
                  googleCalendar.syncStatus === "not_checked",
                reconnect:
                  googleCalendar.syncStatus === "reconnect" ||
                  googleCalendar.syncStatus === "attention",
              }}
              role="status"
            >
              <i />
              {googleCalendar.syncStatus === "pending"
                ? "Sincronizando"
                : googleCalendar.syncStatus === "inactive"
                  ? "Automatización no activada"
                  : googleCalendar.syncStatus === "first_import"
                    ? "Importación pendiente"
                    : googleCalendar.syncStatus === "not_checked"
                      ? "Sin revisión"
                      : googleCalendar.syncStatus === "attention"
                        ? "Revisar sincronización"
                        : googleCalendar.syncStatus === "reconnect"
                          ? "Volver a conectar"
                          : "Todo al día"}
            </span>
          </div>

          <dl class="google-calendar-details">
            <div>
              <dt>Cuenta conectada</dt>
              <dd>{googleCalendar.email || "Cuenta de Google"}</dd>
            </div>
            <div>
              <dt>Calendario</dt>
              <dd>
                {googleCalendar.calendarName || "Calendario del consultorio"}
              </dd>
            </div>
            <div>
              <dt>Última revisión exitosa</dt>
              <dd>
                {formatLastCalendarSync(googleCalendar.lastSyncCompletedAt)}
              </dd>
            </div>
            <div>
              <dt>Último cambio</dt>
              <dd>
                {googleCalendar.lastSyncedAt
                  ? formatLastCalendarSync(googleCalendar.lastSyncedAt)
                  : "Todavía no hubo cambios"}
              </dd>
            </div>
            <div>
              <dt>Bloqueos traídos de Google</dt>
              <dd>
                {googleCalendar.blockCount}
                {googleCalendar.unsupportedCount > 0
                  ? ` · ${googleCalendar.unsupportedCount} evento(s) sin importar`
                  : ""}
              </dd>
            </div>
          </dl>

          {googleCalendar.unsupportedCount > 0 && (
            <p class="settings-note">
              Hay eventos cuya ocupación todavía no se pudo verificar. Mientras
              quede alguno pendiente, la agenda no ofrece horarios ni envía
              cambios a Google, para evitar dobles reservas. No hace falta
              modificar el calendario: volvé a revisarlo para obtener el estado
              actualizado.
            </p>
          )}

          <div class="google-calendar-note">
            <Icon name="info" size={18} />
            <span>
              <strong>Los turnos se administran desde acá.</strong>
              {googleCalendar.automationActive
                ? " Las pre-reservas y los turnos nuevos creados después de la activación se envían a Google; sus cambios y cancelaciones actualizan ese mismo evento."
                : " La sincronización manual sólo revisa Google. Las pre-reservas y los turnos todavía no se envían hasta activar la automatización."}{" "}
              Los eventos que crees a mano en Google aparecen acá como bloqueos
              de agenda, nunca como turnos de pacientes.
            </span>
          </div>

          {state.isAdmin &&
            googleCalendar.inboundSyncState !== "incremental" && (
              <div class="calendar-first-import">
                <h3>Traer los eventos que ya están en Google</h3>
                <p>
                  {googleCalendar.firstImportApproved
                    ? "La importación ya está habilitada, pero todavía no terminó. Revisá nuevamente el calendario antes de reintentar."
                    : "Todavía no importamos nada. La revisión y la importación inicial sólo leen Google: no crean, modifican ni eliminan eventos."}
                </p>
                {googleCalendar.preview && (
                  <>
                    <ul class="calendar-preview-list">
                      <li>
                        <strong>{googleCalendar.preview.managedEvents}</strong>{" "}
                        eventos administrados por esta versión de la agenda
                      </li>
                      <li>
                        <strong>{googleCalendar.preview.externalEvents}</strong>{" "}
                        eventos u ocurrencias externos dentro del horizonte
                        revisado
                      </li>
                      <li>
                        <strong>
                          {googleCalendar.preview.legacyManagedEvents}
                        </strong>{" "}
                        eventos de una integración anterior sin un turno
                        asociado
                      </li>
                      <li>
                        <strong>
                          {googleCalendar.preview.recurringSeries}
                        </strong>{" "}
                        series recurrentes, expandidas en{" "}
                        <strong>
                          {googleCalendar.preview.recurringOccurrences}
                        </strong>{" "}
                        ocurrencias activas
                      </li>
                      <li>
                        <strong>
                          {googleCalendar.preview.cancelledRecurringOccurrences}
                        </strong>{" "}
                        ocurrencias recurrentes canceladas que no bloquearán
                        horarios
                      </li>
                      <li>
                        <strong>{googleCalendar.preview.allDayEvents}</strong>{" "}
                        eventos u ocurrencias de todo el día
                      </li>
                      <li>
                        <strong>
                          {googleCalendar.preview.freeEventsIgnored}
                        </strong>{" "}
                        eventos marcados como libres en Google que no bloquearán
                        horarios
                      </li>
                      <li>
                        <strong>
                          {googleCalendar.preview.wouldBecomeBlocks}
                        </strong>{" "}
                        ocupaciones pasarían a ser bloqueos de agenda
                      </li>
                      <li>
                        <strong>
                          {googleCalendar.preview.unsupportedEvents}
                        </strong>{" "}
                        no se pudieron interpretar con seguridad
                      </li>
                    </ul>
                    <p class="settings-note">
                      Horizonte comprobado: desde{" "}
                      {formatSettingsDate(
                        googleCalendar.preview.coverageStartDate,
                      )}{" "}
                      hasta antes del{" "}
                      {formatSettingsDate(
                        googleCalendar.preview.coverageEndDateExclusive,
                      )}
                      . Las series se cuentan una vez y sus ocurrencias por
                      separado; los grupos pueden superponerse.
                    </p>
                    {(googleCalendar.preview.truncated ||
                      googleCalendar.preview.unsupportedEvents > 0) && (
                      <div class="google-calendar-feedback error" role="alert">
                        <Icon name="alert" size={19} />
                        <span>
                          {googleCalendar.preview.truncated
                            ? "El calendario tiene demasiados eventos para una revisión completa. No habilites la importación."
                            : "No pudimos verificar la ocupación de todos los eventos dentro del horizonte. No modificamos Google ni habilitamos la importación."}
                        </span>
                      </div>
                    )}
                  </>
                )}
                <div class="calendar-first-import-actions">
                  <button
                    class={
                      googleCalendar.preview
                        ? "secondary-button"
                        : "primary-button"
                    }
                    type="button"
                    disabled={
                      Boolean(googleCalendar.action) ||
                      Boolean(googleCalendar.resolving)
                    }
                    onClick$={async () => {
                      if (
                        Boolean(googleCalendar.action) ||
                        Boolean(googleCalendar.resolving)
                      ) {
                        return;
                      }
                      googleCalendar.action = "preview";
                      googleCalendar.error = false;
                      googleCalendar.message = "";
                      googleCalendar.preview = null;
                      try {
                        const { data, error } =
                          await getSupabaseClient().functions.invoke(
                            "process-calendar-sync",
                            {
                              method: "POST",
                              body: { mode: "preview" },
                            },
                          );
                        const preview = parseCalendarImportPreview(data);
                        if (error || !preview) {
                          throw new Error("CALENDAR_PREVIEW_FAILED");
                        }
                        googleCalendar.preview = preview;
                        googleCalendar.message =
                          "Revisamos el calendario sin importar nada todavía.";
                      } catch {
                        googleCalendar.error = true;
                        googleCalendar.message =
                          "No pudimos revisar el calendario. Probá nuevamente.";
                      } finally {
                        googleCalendar.action = "";
                      }
                    }}
                  >
                    {googleCalendar.action === "preview"
                      ? "Revisando…"
                      : "1. Ver qué hay en Google"}
                  </button>
                  <button
                    class="primary-button"
                    type="button"
                    disabled={
                      Boolean(googleCalendar.action) ||
                      Boolean(googleCalendar.resolving) ||
                      !googleCalendar.preview ||
                      googleCalendar.preview.truncated ||
                      googleCalendar.preview.unsupportedEvents > 0
                    }
                    onClick$={async () => {
                      if (
                        Boolean(googleCalendar.action) ||
                        Boolean(googleCalendar.resolving)
                      ) {
                        return;
                      }
                      const reviewedPreview = googleCalendar.preview;
                      if (!reviewedPreview) return;

                      googleCalendar.action = "approve";
                      googleCalendar.error = false;
                      googleCalendar.message = "";
                      let phase:
                        | "rechecking"
                        | "approving"
                        | "importing"
                        | "refreshing" = "rechecking";
                      let approvalSaved = googleCalendar.firstImportApproved;
                      let importCompleted = false;
                      let completedSummaryMessage = "";
                      try {
                        // El calendario puede cambiar entre el
                        // primer resumen y la confirmación. Volvemos
                        // a leerlo antes de guardar la aprobación.
                        const { data: recheckedData, error: recheckedError } =
                          await getSupabaseClient().functions.invoke(
                            "process-calendar-sync",
                            {
                              method: "POST",
                              body: { mode: "preview" },
                            },
                          );
                        const recheckedPreview =
                          parseCalendarImportPreview(recheckedData);
                        if (recheckedError || !recheckedPreview) {
                          throw new Error("CALENDAR_PREVIEW_RECHECK_FAILED");
                        }
                        if (
                          !sameCalendarImportPreview(
                            reviewedPreview,
                            recheckedPreview,
                          )
                        ) {
                          googleCalendar.preview = recheckedPreview;
                          googleCalendar.error = true;
                          googleCalendar.message =
                            "El calendario cambió desde la revisión. Actualizamos el resumen y no importamos nada. Revisalo antes de continuar.";
                          return;
                        }
                        googleCalendar.preview = recheckedPreview;

                        if (!approvalSaved) {
                          if (
                            !window.confirm(
                              `¿Habilitar e importar la ocupación ya existente en Google?\n\n${recheckedPreview.wouldBecomeBlocks} ocupación(es) pasarán a bloquear horarios en la agenda. Esta importación sólo lee Google: no crea, modifica ni elimina eventos.`,
                            )
                          ) {
                            return;
                          }

                          phase = "approving";
                          const { data, error } =
                            await getSupabaseClient().functions.invoke(
                              "process-calendar-sync",
                              {
                                method: "POST",
                                body: {
                                  mode: "approve_first_import",
                                },
                              },
                            );
                          if (error || data?.approved !== true) {
                            throw new Error("CALENDAR_APPROVE_FAILED");
                          }
                          approvalSaved = true;
                          googleCalendar.firstImportApproved = true;
                        }

                        phase = "importing";
                        const { data: importData, error: importError } =
                          await getSupabaseClient().functions.invoke(
                            "process-calendar-sync",
                            {
                              method: "POST",
                              body: { mode: "initial_import" },
                            },
                          );
                        const rawSummary = importData?.summary;
                        const rawInbound = importData?.inbound;
                        const summary = parseCalendarSyncSummary(rawSummary);
                        const outcome = parseCalendarSyncOutcome(
                          importData?.outcome,
                        );
                        if (
                          importError ||
                          importData?.processed !== true ||
                          importData?.mode !== "initial_import" ||
                          importData?.ignored === true ||
                          importData?.reconnectRequired === true ||
                          !rawSummary ||
                          typeof rawSummary !== "object" ||
                          Array.isArray(rawSummary) ||
                          !rawInbound ||
                          typeof rawInbound !== "object" ||
                          Array.isArray(rawInbound) ||
                          outcome !== "completed" ||
                          summary.failed > 0 ||
                          rawInbound.error !== null ||
                          rawInbound.skippedReason !== null ||
                          rawInbound.truncated !== false
                        ) {
                          throw new Error("CALENDAR_INITIAL_IMPORT_FAILED");
                        }

                        importCompleted = true;
                        completedSummaryMessage = describeCalendarSync({
                          summary,
                          outcome,
                          checkedAt: new Date(),
                        });
                        phase = "refreshing";
                        const refreshed = await loadGoogleCalendarStatus();
                        if (
                          !refreshed ||
                          googleCalendar.inboundSyncState !== "incremental"
                        ) {
                          throw new Error(
                            "CALENDAR_INITIAL_IMPORT_UNCONFIRMED",
                          );
                        }
                        googleCalendar.preview = null;
                        googleCalendar.error = false;
                        googleCalendar.message = `Importación inicial completada. ${completedSummaryMessage}`;
                      } catch {
                        if (phase === "rechecking") {
                          googleCalendar.error = true;
                          googleCalendar.message =
                            "No pudimos volver a revisar el calendario. No habilitamos ni importamos nada; probá nuevamente.";
                          return;
                        }

                        if (importCompleted) {
                          googleCalendar.error = true;
                          googleCalendar.message = `Importación inicial completada. ${completedSummaryMessage} No pudimos actualizar el estado del panel; recargá la página antes de volver a intentarlo.`;
                          return;
                        }

                        const refreshed = await loadGoogleCalendarStatus();
                        if (
                          refreshed &&
                          googleCalendar.inboundSyncState === "incremental"
                        ) {
                          googleCalendar.preview = null;
                          googleCalendar.error = true;
                          googleCalendar.message =
                            "La importación quedó registrada, pero no recibimos un resultado completo. Revisá el estado antes de sincronizar nuevamente.";
                          return;
                        }

                        googleCalendar.error = true;
                        if (
                          approvalSaved ||
                          googleCalendar.firstImportApproved
                        ) {
                          googleCalendar.message =
                            "La habilitación quedó guardada, pero la importación no se completó. No se perdió la aprobación: revisá el resumen y tocá «Reintentar importación».";
                        } else {
                          googleCalendar.message =
                            "No pudimos confirmar la habilitación y no importamos eventos. Probá nuevamente.";
                        }
                      } finally {
                        googleCalendar.action = "";
                      }
                    }}
                  >
                    {googleCalendar.action === "approve"
                      ? googleCalendar.firstImportApproved
                        ? "Importando…"
                        : "Habilitando e importando…"
                      : googleCalendar.preview
                        ? googleCalendar.firstImportApproved
                          ? "2. Reintentar importación"
                          : "2. Habilitar e importar"
                        : "2. Primero revisá el calendario"}
                  </button>
                </div>
              </div>
            )}

          {(googleCalendar.conflictCount > 0 ||
            googleCalendar.conflicts.length > 0) && (
            <div class="calendar-conflicts" id="google-calendar-conflicts">
              <h3>Cambios hechos en Google que hay que revisar</h3>
              <p>
                Alguien movió, borró o modificó en Google un turno de un
                paciente. No lo cambiamos solos: decidí vos.
              </p>
              {googleCalendar.conflictsError ? (
                <div class="google-calendar-selection-retry">
                  <div class="google-calendar-feedback error" role="alert">
                    <Icon name="alert" size={19} />
                    <span>{googleCalendar.conflictsError}</span>
                  </div>
                  <button
                    class="secondary-button"
                    type="button"
                    disabled={
                      googleCalendar.loading ||
                      Boolean(googleCalendar.action) ||
                      Boolean(googleCalendar.resolving)
                    }
                    onClick$={loadGoogleCalendarStatus}
                  >
                    {googleCalendar.loading
                      ? "Reintentando…"
                      : "Volver a intentar"}
                  </button>
                </div>
              ) : (
                <ul>
                  {googleCalendar.conflicts.map((conflict) => (
                    <li key={conflict.id}>
                      <div>
                        <strong>{conflict.contactName}</strong>
                        <span>
                          {conflict.kind === "cancellation_requested"
                            ? "Se borró el evento en Google."
                            : conflict.kind === "metadata_changed"
                              ? conflict.imported
                                ? "Cambió el texto o algún dato del evento importado de Google. Revisá la comparación desde este panel; el turno no cambió."
                                : "Se modificaron datos del evento en Google. El turno en la agenda no cambió."
                              : `Se movió al ${formatLastCalendarSync(
                                  conflict.proposedStartsAt ?? "",
                                )}.`}
                        </span>
                      </div>
                      <div class="calendar-conflict-actions">
                        {conflict.imported &&
                          conflict.kind === "metadata_changed" &&
                          state.isAdmin && (
                            <button
                              class="secondary-button"
                              type="button"
                              disabled={
                                googleCalendar.loading ||
                                Boolean(googleCalendar.resolving) ||
                                Boolean(googleCalendar.action)
                              }
                              onClick$={() =>
                                reviewImportedCalendarConflict(conflict.id)
                              }
                            >
                              {googleCalendar.resolving === conflict.id &&
                              googleCalendar.resolvingAction === "review"
                                ? "Revisando…"
                                : googleCalendar.resolving === conflict.id &&
                                    googleCalendar.resolvingAction ===
                                      "accept-title"
                                  ? "Aceptando…"
                                  : googleCalendar.conflictReview
                                        ?.conflictId === conflict.id
                                    ? "Volver a revisar"
                                    : "Revisar cambio"}
                            </button>
                          )}
                        {!conflict.imported && (
                          <button
                            class="secondary-button"
                            type="button"
                            disabled={
                              !state.isAdmin ||
                              Boolean(googleCalendar.resolving) ||
                              Boolean(googleCalendar.action)
                            }
                            onClick$={async () => {
                              if (
                                !state.isAdmin ||
                                conflict.imported ||
                                Boolean(googleCalendar.resolving) ||
                                Boolean(googleCalendar.action)
                              ) {
                                return;
                              }
                              googleCalendar.resolving = conflict.id;
                              googleCalendar.resolvingAction = "reject";
                              googleCalendar.error = false;
                              googleCalendar.message = "";
                              try {
                                const { error } = await getSupabaseClient().rpc(
                                  "reject_google_calendar_conflict",
                                  { p_conflict_id: conflict.id },
                                );
                                if (
                                  error?.message.includes(
                                    "CALENDAR_IMPORTED_APPOINTMENT_READ_ONLY",
                                  )
                                ) {
                                  await loadGoogleCalendarStatus();
                                  googleCalendar.error = true;
                                  googleCalendar.message =
                                    "Este turno viene de un evento creado en Google Calendar. Para restaurarlo o corregirlo, editá el evento original en Google y sincronizá la agenda.";
                                  return;
                                }
                                if (error) throw error;

                                googleCalendar.conflicts =
                                  googleCalendar.conflicts.filter(
                                    (item) => item.id !== conflict.id,
                                  );
                                googleCalendar.conflictCount = Math.max(
                                  0,
                                  googleCalendar.conflictCount - 1,
                                );
                                const refreshed =
                                  await loadGoogleCalendarStatus();
                                googleCalendar.error = !refreshed;
                                googleCalendar.message = refreshed
                                  ? "Dejamos el turno como está acá y lo vamos a restaurar en Google."
                                  : "La decisión se guardó, pero no pudimos actualizar la vista. Recargá esta sección antes de continuar.";
                              } catch {
                                const refreshed =
                                  await loadGoogleCalendarStatus();
                                googleCalendar.error = true;
                                googleCalendar.message = refreshed
                                  ? "No pudimos confirmar si la decisión se guardó. Revisá el estado antes de volver a intentar."
                                  : "No pudimos confirmar si la decisión se guardó ni recargar el estado. Recargá esta sección antes de volver a intentar.";
                              } finally {
                                googleCalendar.resolving = "";
                                googleCalendar.resolvingAction = "";
                              }
                            }}
                          >
                            {googleCalendar.resolving === conflict.id &&
                            googleCalendar.resolvingAction === "reject"
                              ? "Guardando…"
                              : "Restaurar desde la agenda"}
                          </button>
                        )}
                        {conflict.kind !== "metadata_changed" && (
                          <button
                            class="primary-button"
                            type="button"
                            disabled={
                              !state.isAdmin ||
                              Boolean(googleCalendar.resolving) ||
                              Boolean(googleCalendar.action)
                            }
                            onClick$={async () => {
                              if (
                                !state.isAdmin ||
                                Boolean(googleCalendar.resolving) ||
                                Boolean(googleCalendar.action)
                              ) {
                                return;
                              }
                              if (
                                !window.confirm(
                                  conflict.kind === "cancellation_requested"
                                    ? "¿Cancelar este turno en la agenda?"
                                    : "¿Mover este turno al horario que quedó en Google?",
                                )
                              ) {
                                return;
                              }
                              googleCalendar.resolving = conflict.id;
                              googleCalendar.resolvingAction = "apply";
                              googleCalendar.error = false;
                              googleCalendar.message = "";
                              try {
                                const { error } = await getSupabaseClient().rpc(
                                  "apply_google_calendar_conflict",
                                  { p_conflict_id: conflict.id },
                                );
                                if (error) throw error;

                                googleCalendar.conflicts =
                                  googleCalendar.conflicts.filter(
                                    (item) => item.id !== conflict.id,
                                  );
                                googleCalendar.conflictCount = Math.max(
                                  0,
                                  googleCalendar.conflictCount - 1,
                                );
                                const refreshed =
                                  await loadGoogleCalendarStatus();
                                googleCalendar.error = !refreshed;
                                googleCalendar.message = refreshed
                                  ? "Aplicamos el cambio en la agenda."
                                  : "El cambio se guardó, pero no pudimos actualizar la vista. Recargá esta sección antes de continuar.";
                              } catch {
                                const refreshed =
                                  await loadGoogleCalendarStatus();
                                googleCalendar.error = true;
                                googleCalendar.message = refreshed
                                  ? "No pudimos confirmar si el cambio se aplicó. Revisá el estado antes de volver a intentar."
                                  : "No pudimos confirmar si el cambio se aplicó ni recargar el estado. Recargá esta sección antes de volver a intentar.";
                              } finally {
                                googleCalendar.resolving = "";
                                googleCalendar.resolvingAction = "";
                              }
                            }}
                          >
                            {googleCalendar.resolving === conflict.id &&
                            googleCalendar.resolvingAction === "apply"
                              ? "Aplicando…"
                              : "Aplicar cambio"}
                          </button>
                        )}
                      </div>
                      {state.isAdmin &&
                        conflict.imported &&
                        googleCalendar.conflictReview?.conflictId ===
                          conflict.id && (
                          <section
                            class="calendar-conflict-review"
                            aria-label="Comparación del texto del evento"
                          >
                            <h4>
                              Revisá el cambio de{" "}
                              {googleCalendar.conflictReview.patientName}
                            </h4>
                            <div class="calendar-conflict-comparison">
                              <div>
                                <strong>Texto guardado al importar</strong>
                                <p>
                                  {googleCalendar.conflictReview.local.title}
                                </p>
                                <span>
                                  Desde{" "}
                                  {formatLastCalendarSync(
                                    googleCalendar.conflictReview.local
                                      .startsAt,
                                  )}
                                  {" · Hasta "}
                                  {formatLastCalendarSync(
                                    googleCalendar.conflictReview.local.endsAt,
                                  )}
                                </span>
                              </div>
                              <div>
                                <strong>Texto actual en Google</strong>
                                <p>
                                  {googleCalendar.conflictReview.remote.title ||
                                    "Sin título"}
                                </p>
                                <span>
                                  {googleCalendar.conflictReview.remote
                                    .startsAt &&
                                  googleCalendar.conflictReview.remote.endsAt
                                    ? `Desde ${formatLastCalendarSync(googleCalendar.conflictReview.remote.startsAt)} · Hasta ${formatLastCalendarSync(googleCalendar.conflictReview.remote.endsAt)}`
                                    : "Horario no disponible en Google"}
                                </span>
                              </div>
                            </div>
                            {googleCalendar.conflictReview.canAcceptTitle &&
                            googleCalendar.conflictReview.reviewToken ? (
                              <>
                                <p>
                                  Podés aceptar este texto desde el panel. No
                                  cambia el paciente, la cobertura ni el horario
                                  del turno y no escribe en Google Calendar.
                                  Aceptar el texto no registra pagos ni confirma
                                  una seña.
                                </p>
                                <label class="calendar-conflict-confirmation">
                                  <input
                                    type="checkbox"
                                    checked={
                                      googleCalendar.conflictReviewConfirmed
                                    }
                                    disabled={
                                      googleCalendar.loading ||
                                      Boolean(googleCalendar.resolving) ||
                                      Boolean(googleCalendar.action)
                                    }
                                    onChange$={(_, element) => {
                                      googleCalendar.conflictReviewConfirmed =
                                        element.checked;
                                    }}
                                  />
                                  <span>
                                    Revisé ambos textos y confirmo que
                                    corresponden al mismo paciente y turno.
                                    Entiendo que aceptar el texto no registra
                                    pagos ni confirma una seña.
                                  </span>
                                </label>
                                <button
                                  class="primary-button"
                                  type="button"
                                  disabled={
                                    !googleCalendar.conflictReviewConfirmed ||
                                    googleCalendar.loading ||
                                    Boolean(googleCalendar.resolving) ||
                                    Boolean(googleCalendar.action)
                                  }
                                  onClick$={() =>
                                    acceptImportedCalendarTitle(conflict.id)
                                  }
                                >
                                  Aceptar texto de Google
                                </button>
                              </>
                            ) : (
                              <p
                                class="calendar-conflict-review-blocked"
                                role="status"
                              >
                                {describeCalendarConflictReviewBlock(
                                  googleCalendar.conflictReview.reason,
                                )}
                              </p>
                            )}
                          </section>
                        )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {state.isAdmin && (
            <div class="google-calendar-actions">
              {googleCalendar.syncStatus === "reconnect" && (
                <button
                  class="primary-button"
                  type="button"
                  disabled={
                    Boolean(googleCalendar.action) ||
                    Boolean(googleCalendar.resolving)
                  }
                  onClick$={async () => {
                    if (
                      Boolean(googleCalendar.action) ||
                      Boolean(googleCalendar.resolving)
                    ) {
                      return;
                    }
                    googleCalendar.action = "connect";
                    googleCalendar.error = false;
                    googleCalendar.message = "";
                    try {
                      const { data, error } =
                        await getSupabaseClient().functions.invoke(
                          "google-calendar-oauth-start",
                          { method: "POST" },
                        );
                      if (error || typeof data?.authorizationUrl !== "string") {
                        throw new Error("GOOGLE_CALENDAR_OAUTH_FAILED");
                      }
                      window.location.assign(data.authorizationUrl);
                    } catch {
                      googleCalendar.error = true;
                      googleCalendar.message =
                        "No pudimos abrir Google. Probá nuevamente.";
                      googleCalendar.action = "";
                    }
                  }}
                >
                  {googleCalendar.action === "connect"
                    ? "Abriendo Google…"
                    : "Volver a conectar"}
                </button>
              )}
              <button
                class={
                  googleCalendar.syncStatus === "reconnect"
                    ? "secondary-button"
                    : "primary-button"
                }
                type="button"
                disabled={
                  !canRunManualGoogleCalendarSync(
                    googleCalendar.firstImportApproved,
                    googleCalendar.inboundSyncState,
                    googleCalendar.connected,
                  ) ||
                  Boolean(googleCalendar.action) ||
                  Boolean(googleCalendar.resolving)
                }
                onClick$={async () => {
                  if (
                    !canRunManualGoogleCalendarSync(
                      googleCalendar.firstImportApproved,
                      googleCalendar.inboundSyncState,
                      googleCalendar.connected,
                    )
                  ) {
                    googleCalendar.error = false;
                    googleCalendar.message =
                      "Completá la importación inicial desde el panel anterior antes de sincronizar nuevamente.";
                    return;
                  }
                  if (
                    Boolean(googleCalendar.action) ||
                    Boolean(googleCalendar.resolving)
                  ) {
                    return;
                  }
                  googleCalendar.action = "sync";
                  googleCalendar.error = false;
                  googleCalendar.message = "";
                  try {
                    const { data, error } =
                      await getSupabaseClient().functions.invoke(
                        "process-calendar-sync",
                        {
                          method: "POST",
                          body: { mode: "manual" },
                        },
                      );
                    if (
                      error ||
                      data?.processed !== true ||
                      data?.reconnectRequired === true ||
                      data?.ignored === true
                    ) {
                      throw new Error("GOOGLE_CALENDAR_SYNC_FAILED");
                    }
                    // El panel vuelve a leer el estado siempre,
                    // también cuando no hubo un solo cambio.
                    await loadGoogleCalendarStatus();
                    const summary = parseCalendarSyncSummary(data?.summary);
                    const outcome = parseCalendarSyncOutcome(data?.outcome);
                    googleCalendar.error =
                      outcome === "error" || summary.failed > 0;
                    googleCalendar.message =
                      summary.failed > 0
                        ? "Algunos turnos necesitan revisión. La agenda sigue guardada de forma segura."
                        : describeCalendarSync({
                            summary,
                            outcome,
                            checkedAt:
                              googleCalendar.lastSyncCompletedAt || new Date(),
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
                    googleCalendar.error = true;
                    googleCalendar.message =
                      "No pudimos sincronizar ahora. Probá nuevamente en unos minutos.";
                  } finally {
                    googleCalendar.action = "";
                  }
                }}
              >
                {googleCalendar.inboundSyncState !== "incremental"
                  ? "Completá la importación primero"
                  : googleCalendar.action === "sync"
                    ? "Sincronizando…"
                    : "Sincronizar ahora"}
              </button>
              <button
                class="secondary-button danger-button"
                type="button"
                disabled={
                  Boolean(googleCalendar.action) ||
                  Boolean(googleCalendar.resolving)
                }
                onClick$={async () => {
                  if (
                    Boolean(googleCalendar.action) ||
                    Boolean(googleCalendar.resolving)
                  ) {
                    return;
                  }
                  const confirmed = window.confirm(
                    "¿Querés desconectar Google Calendar? Los turnos seguirán guardados en esta aplicación, pero dejarán de enviarse a Google.",
                  );
                  if (!confirmed) return;

                  googleCalendar.action = "disconnect";
                  googleCalendar.error = false;
                  googleCalendar.message = "";
                  try {
                    const { data, error } =
                      await getSupabaseClient().functions.invoke(
                        "google-calendar-disconnect",
                        { method: "POST" },
                      );
                    if (error || data?.disconnected !== true) {
                      throw new Error("GOOGLE_CALENDAR_DISCONNECT_FAILED");
                    }
                    googleCalendar.connected = false;
                    googleCalendar.email = "";
                    googleCalendar.calendarName = "";
                    googleCalendar.lastSyncedAt = "";
                    googleCalendar.lastCheckedAt = "";
                    googleCalendar.lastSyncCompletedAt = "";
                    googleCalendar.automationActive = false;
                    googleCalendar.syncStatus = "synced";
                    googleCalendar.message =
                      data.remoteRevocationConfirmed === true
                        ? "Google Calendar fue desconectado. Tus turnos siguen guardados acá."
                        : "La conexión local fue eliminada y tus turnos siguen guardados. Google no confirmó la revocación: quitá el acceso desde tu cuenta de Google antes de conectar otra cuenta.";
                  } catch {
                    googleCalendar.error = true;
                    googleCalendar.message =
                      "No pudimos desconectar Google Calendar. Probá nuevamente.";
                  } finally {
                    googleCalendar.action = "";
                  }
                }}
              >
                {googleCalendar.action === "disconnect"
                  ? "Desconectando…"
                  : "Desconectar"}
              </button>
            </div>
          )}
        </div>
      ) : (
        <div class="google-calendar-card google-calendar-empty">
          <span class="google-calendar-icon">
            <Icon name="calendar" size={28} />
          </span>
          <div>
            <h3>
              {state.isAdmin
                ? "Conectá tu Google Calendar"
                : "Google Calendar no está conectado"}
            </h3>
            <p>
              {state.isAdmin
                ? "Al tocar el botón, Google te pedirá elegir una cuenta y aceptar el acceso al calendario. No necesitás copiar claves ni completar datos técnicos."
                : "Pedile a la persona administradora que haga la conexión una sola vez. Después la sincronización es automática."}
            </p>
          </div>
          {!googleCalendar.configured && (
            <div class="google-calendar-feedback" role="alert">
              <Icon name="alert" size={19} />
              <span>
                La conexión todavía no está preparada. Pedile ayuda a la persona
                que configuró la aplicación.
              </span>
            </div>
          )}
          {state.isAdmin && (
            <button
              class="primary-button"
              type="button"
              disabled={
                !googleCalendar.configured ||
                Boolean(googleCalendar.action) ||
                Boolean(googleCalendar.resolving)
              }
              onClick$={async () => {
                if (
                  Boolean(googleCalendar.action) ||
                  Boolean(googleCalendar.resolving)
                ) {
                  return;
                }
                googleCalendar.action = "connect";
                googleCalendar.error = false;
                googleCalendar.message = "";
                try {
                  const { data, error } =
                    await getSupabaseClient().functions.invoke(
                      "google-calendar-oauth-start",
                      { method: "POST" },
                    );
                  if (error || typeof data?.authorizationUrl !== "string") {
                    throw new Error("GOOGLE_CALENDAR_OAUTH_FAILED");
                  }
                  window.location.assign(data.authorizationUrl);
                } catch {
                  googleCalendar.error = true;
                  googleCalendar.message =
                    "No pudimos abrir Google. Probá nuevamente.";
                  googleCalendar.action = "";
                }
              }}
            >
              {googleCalendar.action === "connect"
                ? "Abriendo Google…"
                : "Conectar con Google"}
            </button>
          )}
        </div>
      )}
    </section>
  );
});
