import {
  $,
  component$,
  useSignal,
  useStore,
  useVisibleTask$,
  type QRL,
} from "@qwik.dev/core";
import { Icon } from "~/components/ui/Icon";
import { formatBusinessDate } from "~/lib/date-time";
import {
  calendarConflictActions,
  type CalendarConflictKind,
} from "~/lib/calendar-conflict-actions";
import {
  describeCalendarConflictReviewBlock,
  parseCalendarConflictReview,
  type CalendarConflictReview,
} from "~/lib/google-calendar-conflict-review";
import { getSupabaseClient } from "~/lib/supabase/client";
import type { CalendarConflict } from "~/lib/supabase/data";
import "./calendar-conflict.css";

interface Props {
  conflict: CalendarConflict;
  isAdmin: boolean;
  onClose$: QRL<() => void>;
  onResolved$: QRL<(message: string) => void>;
}

function whenLabel(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return formatBusinessDate(date, { dateStyle: "full", timeStyle: "short" });
}

function kindTitle(kind: CalendarConflictKind): string {
  if (kind === "cancellation_requested") return "Se borró el evento en Google";
  if (kind === "metadata_changed") return "Cambió el texto del evento";
  return "Se movió el turno en Google";
}

/**
 * Comparación lado a lado de un conflicto de Google Calendar.
 *
 * Muestra las dos versiones y deja elegir cuál gana con un clic. Nada se
 * decide en el navegador: cada acción llama a la misma RPC o endpoint que ya
 * usaba Configuración, que revalidan rol, estado del conflicto y propiedad del
 * turno. Si la respuesta es dudosa, la pantalla lo dice y no da por hecho que
 * el cambio se guardó.
 */
export const CalendarConflictModal = component$<Props>((props) => {
  const dialogRef = useSignal<HTMLElement>();
  const state = useStore<{
    working: "" | "keep-local" | "apply-remote" | "review" | "accept-title";
    error: string;
    review: CalendarConflictReview | null;
    reviewConfirmed: boolean;
  }>({ working: "", error: "", review: null, reviewConfirmed: false });

  const actions = calendarConflictActions({
    kind: props.conflict.kind,
    imported: props.conflict.imported,
    isAdmin: props.isAdmin,
  });

  // Foco al abrir y devolución al cerrar.
  // eslint-disable-next-line qwik/no-use-visible-task
  useVisibleTask$(({ cleanup }) => {
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : undefined;
    dialogRef.value?.focus();
    cleanup(() => {
      if (previous && document.contains(previous)) previous.focus();
    });
  });

  // El texto de Google sólo se puede comparar pidiéndoselo al endpoint que lo
  // valida; nunca se muestra un título remoto sin esa revisión.
  // eslint-disable-next-line qwik/no-use-visible-task
  useVisibleTask$(async () => {
    if (!actions.canAcceptTitle) return;
    state.working = "review";
    try {
      const { data, error } = await getSupabaseClient().functions.invoke(
        "google-calendar-conflict-review",
        { body: { action: "review", conflictId: props.conflict.id } },
      );
      const review = parseCalendarConflictReview(data, props.conflict.id);
      if (error || !review) throw new Error("CALENDAR_CONFLICT_REVIEW_FAILED");
      state.review = review;
    } catch {
      state.error =
        "No pudimos revisar el cambio. No aceptamos nada: cerrá y volvé a intentarlo.";
    } finally {
      state.working = "";
    }
  });

  const runRpc = $(
    async (
      action: "keep-local" | "apply-remote",
      rpc: "reject_google_calendar_conflict" | "apply_google_calendar_conflict",
      successMessage: string,
    ) => {
      if (state.working) return;
      state.working = action;
      state.error = "";
      try {
        const { error } = await getSupabaseClient().rpc(rpc, {
          p_conflict_id: props.conflict.id,
        });
        if (
          error?.message.includes("CALENDAR_IMPORTED_APPOINTMENT_READ_ONLY")
        ) {
          state.error =
            "Este turno vino de un evento creado en Google Calendar. Editá el evento allá y volvé a sincronizar.";
          return;
        }
        if (error) throw error;
        await props.onResolved$(successMessage);
      } catch {
        state.error =
          "No pudimos confirmar si la decisión se guardó. Revisá la agenda antes de volver a intentar.";
      } finally {
        state.working = "";
      }
    },
  );

  const acceptTitle = $(async () => {
    const review = state.review;
    if (
      state.working ||
      !review ||
      !review.canAcceptTitle ||
      !review.reviewToken ||
      !state.reviewConfirmed
    ) {
      return;
    }
    state.working = "accept-title";
    state.error = "";
    // Una respuesta dudosa exige una revisión nueva, nunca reutilizar el token.
    state.review = null;
    state.reviewConfirmed = false;
    try {
      const { data, error } = await getSupabaseClient().functions.invoke(
        "google-calendar-conflict-review",
        {
          body: {
            action: "accept_title",
            conflictId: props.conflict.id,
            reviewToken: review.reviewToken,
          },
        },
      );
      if (error || data?.resolved !== true) {
        throw new Error("CALENDAR_CONFLICT_ACCEPT_FAILED");
      }
      await props.onResolved$(
        "Aceptamos el texto de Google. No cambiamos el paciente ni el horario.",
      );
    } catch {
      state.error =
        "No pudimos confirmar la aceptación. Revisá el estado antes de volver a decidir.";
    } finally {
      state.working = "";
    }
  });

  const busy = Boolean(state.working);
  const remoteWhen =
    props.conflict.kind === "cancellation_requested"
      ? "El evento ya no está en Google"
      : whenLabel(
          props.conflict.proposedStartsAt ?? props.conflict.observedStartsAt,
        );

  return (
    <div
      class="drawer-layer"
      role="presentation"
      onClick$={() => {
        if (!busy) props.onClose$();
      }}
    >
      <aside
        ref={dialogRef}
        class="drawer calendar-conflict-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="calendar-conflict-title"
        aria-busy={busy}
        tabIndex={-1}
        stoppropagation:click
        onKeyDown$={(event) => {
          if (event.key === "Escape" && !busy) {
            event.preventDefault();
            props.onClose$();
          }
        }}
      >
        <header class="drawer-header">
          <div>
            <span class="eyebrow">Google Calendar</span>
            <h2 id="calendar-conflict-title">
              {kindTitle(props.conflict.kind)}
            </h2>
          </div>
          <button
            type="button"
            aria-label="Cerrar"
            disabled={busy}
            onClick$={() => props.onClose$()}
          >
            <Icon name="x" size={19} />
          </button>
        </header>

        <div class="drawer-body">
          <p class="calendar-conflict-lead">
            <strong>{props.conflict.contactName}</strong> · Elegí qué versión
            queda. Hasta que decidas, el turno de la agenda no cambió.
          </p>

          <div class="calendar-conflict-compare">
            <section class="calendar-conflict-side local">
              <h3>En la agenda</h3>
              <dl>
                <div>
                  <dt>Cuándo</dt>
                  <dd>
                    {whenLabel(
                      state.review?.local.startsAt ??
                        props.conflict.observedStartsAt,
                    )}
                  </dd>
                </div>
                {state.review && (
                  <div>
                    <dt>Texto</dt>
                    <dd>{state.review.local.title}</dd>
                  </div>
                )}
              </dl>
              {actions.canKeepLocal && (
                <button
                  class="primary-button"
                  type="button"
                  disabled={busy}
                  onClick$={() =>
                    runRpc(
                      "keep-local",
                      "reject_google_calendar_conflict",
                      "Dejamos el turno como está acá y lo vamos a restaurar en Google.",
                    )
                  }
                >
                  {state.working === "keep-local"
                    ? "Guardando…"
                    : "Conservar esta versión"}
                </button>
              )}
            </section>

            <section class="calendar-conflict-side remote">
              <h3>En Google Calendar</h3>
              <dl>
                <div>
                  <dt>Cuándo</dt>
                  <dd>{remoteWhen}</dd>
                </div>
                {state.review && (
                  <div>
                    <dt>Texto</dt>
                    <dd>{state.review.remote.title || "(vacío)"}</dd>
                  </div>
                )}
              </dl>

              {actions.canApplyRemote && (
                <button
                  class="primary-button"
                  type="button"
                  disabled={busy}
                  onClick$={() =>
                    runRpc(
                      "apply-remote",
                      "apply_google_calendar_conflict",
                      props.conflict.kind === "cancellation_requested"
                        ? "Cancelamos el turno en la agenda."
                        : "Movimos el turno al horario que quedó en Google.",
                    )
                  }
                >
                  {state.working === "apply-remote"
                    ? "Aplicando…"
                    : props.conflict.kind === "cancellation_requested"
                      ? "Cancelar el turno"
                      : "Usar esta versión"}
                </button>
              )}

              {actions.canAcceptTitle && (
                <>
                  {state.working === "review" ? (
                    <p class="calendar-conflict-note" role="status">
                      <span class="small-spinner" aria-hidden="true" />{" "}
                      Revisando el cambio…
                    </p>
                  ) : state.review?.canAcceptTitle ? (
                    <>
                      <label class="calendar-conflict-confirm">
                        <input
                          type="checkbox"
                          checked={state.reviewConfirmed}
                          onChange$={(_, element) =>
                            (state.reviewConfirmed = element.checked)
                          }
                        />
                        <span>
                          Verifiqué que es el mismo paciente y el mismo horario.
                        </span>
                      </label>
                      <button
                        class="primary-button"
                        type="button"
                        disabled={busy || !state.reviewConfirmed}
                        onClick$={acceptTitle}
                      >
                        {state.working === "accept-title"
                          ? "Aceptando…"
                          : "Aceptar sólo el texto"}
                      </button>
                    </>
                  ) : state.review ? (
                    <p class="calendar-conflict-note">
                      {describeCalendarConflictReviewBlock(state.review.reason)}
                    </p>
                  ) : null}
                </>
              )}
            </section>
          </div>

          {actions.blockedReason && (
            <p class="calendar-conflict-note">{actions.blockedReason}</p>
          )}

          {state.error && (
            <p class="calendar-conflict-error" role="alert">
              {state.error}
            </p>
          )}
        </div>

        <div class="drawer-form-actions">
          <button
            class="secondary-button"
            type="button"
            disabled={busy}
            onClick$={() => props.onClose$()}
          >
            Decidir más tarde
          </button>
        </div>
      </aside>
    </div>
  );
});
