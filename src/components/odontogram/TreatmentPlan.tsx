import {
  $,
  component$,
  useSignal,
  useStore,
  useVisibleTask$,
} from "@qwik.dev/core";
import { Icon } from "~/components/ui/Icon";
import { CONDITION_LABELS, type OdontogramEntry } from "~/lib/odontogram";
import {
  formatArs,
  suggestTreatmentItems,
  treatmentPlanTotals,
  treatmentProgress,
  TREATMENT_STATUS_LABELS,
  TREATMENT_STATUS_TONES,
  type TreatmentItemStatus,
  type TreatmentPlanItem,
} from "~/lib/treatment-plan";
import { getSupabaseClient } from "~/lib/supabase/client";
import {
  createTreatmentItem,
  deleteTreatmentItem,
  loadTreatmentPlan,
  updateTreatmentItemStatus,
} from "~/lib/supabase/treatment-plan";
import "./treatment-plan.css";

interface Props {
  contactId: string;
  /** Estado vigente de cada pieza, para proponer trabajo. */
  currentEntries: OdontogramEntry[];
}

const STATUSES: TreatmentItemStatus[] = [
  "pending",
  "in_progress",
  "done",
  "cancelled",
];

/**
 * Plan de tratamiento y presupuesto.
 *
 * Convive con el odontograma pero no lo toca: marcar un ítem como hecho **no**
 * registra un hallazgo clínico. El odontograma es append-only y lo escribe la
 * profesional; esto es un presupuesto que cambia.
 *
 * El verde de "en curso" es de avance de tratamiento. La ficha clínica
 * conserva su propia convención de colores.
 */
export const TreatmentPlan = component$<Props>(
  ({ contactId, currentEntries }) => {
    const reloadVersion = useSignal(0);
    const draftTooth = useSignal("");
    const draftDescription = useSignal("");
    const draftCost = useSignal("");
    const state = useStore<{
      items: TreatmentPlanItem[];
      loading: boolean;
      saving: boolean;
      error: string;
    }>({ items: [], loading: true, saving: false, error: "" });

    // eslint-disable-next-line qwik/no-use-visible-task
    useVisibleTask$(async ({ track }) => {
      track(() => contactId);
      track(() => reloadVersion.value);
      if (!contactId) {
        state.items = [];
        state.loading = false;
        return;
      }
      state.loading = true;
      state.error = "";
      try {
        state.items = await loadTreatmentPlan(getSupabaseClient(), contactId);
      } catch {
        state.error = "No pudimos cargar el plan de tratamiento.";
      } finally {
        state.loading = false;
      }
    });

    const add = $(async (tooth: number | null, description: string) => {
      if (state.saving || !description.trim()) return;
      state.saving = true;
      state.error = "";
      try {
        const parsedCost = Number(draftCost.value.replace(/\D/g, ""));
        await createTreatmentItem(getSupabaseClient(), {
          contactId,
          tooth,
          description,
          estimatedCostArs:
            Number.isFinite(parsedCost) && parsedCost > 0 ? parsedCost : null,
        });
        draftTooth.value = "";
        draftDescription.value = "";
        draftCost.value = "";
        reloadVersion.value += 1;
      } catch {
        state.error = "No pudimos agregar el ítem. Sólo ADMIN puede hacerlo.";
      } finally {
        state.saving = false;
      }
    });

    const totals = treatmentPlanTotals(state.items);
    const progress = treatmentProgress(state.items);
    const suggestions = suggestTreatmentItems(
      currentEntries.map((entry) => ({
        tooth: entry.tooth,
        condition: entry.condition,
      })),
      state.items,
    );

    return (
      <section class="treatment-plan" aria-labelledby="treatment-plan-title">
        <header>
          <div>
            <h2 id="treatment-plan-title">Plan de tratamiento</h2>
            <p>
              Presupuesto y avance. No es historia clínica: marcar algo como
              hecho no registra un hallazgo en el odontograma.
            </p>
          </div>
          {progress !== null && (
            <div
              class="treatment-progress"
              role="img"
              aria-label={`Avance del plan: ${progress}%`}
            >
              <strong>{progress}%</strong>
              <span
                class="treatment-progress-bar"
                style={{ "--progress": `${progress}%` }}
              />
            </div>
          )}
        </header>

        {state.error && (
          <p class="treatment-error" role="alert">
            {state.error}
          </p>
        )}

        {suggestions.length > 0 && (
          <div class="treatment-suggestions">
            <span>Sugerencias del odontograma</span>
            <div>
              {suggestions.slice(0, 6).map((suggestion) => (
                <button
                  key={`${suggestion.tooth}-${suggestion.description}`}
                  class="filter-pill"
                  type="button"
                  disabled={state.saving}
                  onClick$={() => add(suggestion.tooth, suggestion.description)}
                >
                  <Icon name="plus" size={14} /> {suggestion.tooth}{" "}
                  {suggestion.description}
                </button>
              ))}
            </div>
          </div>
        )}

        <div class="treatment-composer">
          <label class="form-field">
            <span>Pieza (opcional)</span>
            <input
              type="text"
              inputMode="numeric"
              maxLength={2}
              value={draftTooth.value}
              placeholder="16"
              onInput$={(_, element) =>
                (draftTooth.value = element.value.replace(/\D/g, ""))
              }
            />
          </label>
          <label class="form-field">
            <span>Trabajo</span>
            <input
              type="text"
              maxLength={300}
              value={draftDescription.value}
              placeholder="Obturación oclusal"
              onInput$={(_, element) =>
                (draftDescription.value = element.value)
              }
            />
          </label>
          <label class="form-field">
            <span>Costo estimado</span>
            <input
              type="text"
              inputMode="numeric"
              value={draftCost.value}
              placeholder="45000"
              onInput$={(_, element) =>
                (draftCost.value = element.value.replace(/\D/g, ""))
              }
            />
          </label>
          <button
            class="primary-button"
            type="button"
            disabled={state.saving || !draftDescription.value.trim()}
            onClick$={() =>
              add(
                draftTooth.value ? Number(draftTooth.value) : null,
                draftDescription.value,
              )
            }
          >
            {state.saving ? "Agregando…" : "Agregar"}
          </button>
        </div>

        {state.loading ? (
          <p class="treatment-empty" role="status">
            <span class="small-spinner" aria-hidden="true" /> Cargando el plan…
          </p>
        ) : state.items.length === 0 ? (
          <p class="treatment-empty">Todavía no hay trabajos planificados.</p>
        ) : (
          <>
            <ul class="treatment-list">
              {state.items.map((item) => (
                <li
                  key={item.id}
                  class={`tone-${TREATMENT_STATUS_TONES[item.status]}`}
                >
                  <span class="treatment-item-copy">
                    <strong>
                      {item.tooth ? `Pieza ${item.tooth} · ` : ""}
                      {item.description}
                    </strong>
                    <small>
                      {item.estimatedCostArs
                        ? formatArs(item.estimatedCostArs)
                        : "Sin costo cargado"}
                    </small>
                  </span>

                  <label class="treatment-item-status">
                    <span class="sr-only">Estado de {item.description}</span>
                    <select
                      value={item.status}
                      onChange$={async (_, element) => {
                        const next = element.value as TreatmentItemStatus;
                        try {
                          await updateTreatmentItemStatus(
                            getSupabaseClient(),
                            item.id,
                            next,
                          );
                          reloadVersion.value += 1;
                        } catch {
                          state.error = "No pudimos cambiar el estado.";
                        }
                      }}
                    >
                      {STATUSES.map((status) => (
                        <option key={status} value={status}>
                          {TREATMENT_STATUS_LABELS[status]}
                        </option>
                      ))}
                    </select>
                  </label>

                  <button
                    class="treatment-item-delete"
                    type="button"
                    aria-label={`Quitar ${item.description}`}
                    onClick$={async () => {
                      if (!window.confirm("¿Quitar este ítem del plan?"))
                        return;
                      try {
                        await deleteTreatmentItem(getSupabaseClient(), item.id);
                        reloadVersion.value += 1;
                      } catch {
                        state.error = "No pudimos quitar el ítem.";
                      }
                    }}
                  >
                    <Icon name="x" size={15} />
                  </button>
                </li>
              ))}
            </ul>

            <dl class="treatment-totals">
              <div>
                <dt>Falta hacer</dt>
                <dd>{formatArs(totals.remainingArs)}</dd>
              </div>
              <div>
                <dt>Ya hecho</dt>
                <dd>{formatArs(totals.doneArs)}</dd>
              </div>
              <div>
                <dt>Total del plan</dt>
                <dd>{formatArs(totals.totalArs)}</dd>
              </div>
            </dl>
            {totals.withoutCost > 0 && (
              <p class="treatment-note">
                {totals.withoutCost} ítem
                {totals.withoutCost === 1 ? "" : "s"} sin costo cargado; no
                suman al total.
              </p>
            )}
          </>
        )}

        {currentEntries.length > 0 && suggestions.length === 0 && (
          <p class="treatment-note">
            Hallazgos vigentes:{" "}
            {currentEntries
              .slice(0, 4)
              .map(
                (entry) =>
                  `${entry.tooth} ${CONDITION_LABELS[entry.condition]}`,
              )
              .join(" · ")}
          </p>
        )}
      </section>
    );
  },
);
