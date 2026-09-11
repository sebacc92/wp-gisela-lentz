import { $, component$, useSignal, useStore, type QRL } from "@qwik.dev/core";
import { Icon } from "~/components/ui/Icon";
import {
  DUPLICATE_REASON_LABELS,
  findDuplicatePairs,
  mergeBlock,
  type DuplicateCandidateInput,
  type DuplicatePair,
} from "~/lib/patient-duplicates";
import { getSupabaseClient } from "~/lib/supabase/client";
import "./duplicate-assistant.css";

interface Props {
  candidates: DuplicateCandidateInput[];
  isAdmin: boolean;
  onClose$: QRL<() => void>;
  onMerged$: QRL<(message: string) => void>;
}

/**
 * Asistente de fichas duplicadas.
 *
 * Propone pares y deja que una persona decida. La fusión la resuelve
 * `merge_patient_records` en la base: mueve turnos, mensajes y conversaciones
 * en una sola transacción auditada, **no borra** la ficha duplicada y se niega
 * si tiene odontograma cargado.
 */
export const DuplicateAssistant = component$<Props>((props) => {
  const state = useStore<{ merging: string; error: string }>({
    merging: "",
    error: "",
  });
  const dismissed = useSignal<string[]>([]);

  const pairs = findDuplicatePairs(props.candidates).filter(
    (pair) =>
      !dismissed.value.includes(`${pair.primary.id}:${pair.duplicate.id}`),
  );

  const merge = $(async (pair: DuplicatePair) => {
    const key = `${pair.primary.id}:${pair.duplicate.id}`;
    if (state.merging) return;

    const block = mergeBlock(pair);
    if (block.blocked) {
      state.error = block.reason ?? "No se puede fusionar.";
      return;
    }
    if (
      !window.confirm(
        `¿Unir "${pair.duplicate.name}" dentro de "${pair.primary.name}"?\n\n` +
          "Se mueven los turnos, los mensajes y las conversaciones. La ficha " +
          "duplicada queda marcada como fusionada, no se borra.",
      )
    ) {
      return;
    }

    state.merging = key;
    state.error = "";
    try {
      const { error } = await getSupabaseClient().rpc("merge_patient_records", {
        p_primary_id: pair.primary.id,
        p_duplicate_id: pair.duplicate.id,
      });
      if (error) {
        state.error = error.message.includes("PATIENT_MERGE_CLINICAL_HISTORY")
          ? "Esa ficha tiene odontograma cargado. La historia clínica no se reasigna desde acá."
          : error.message.includes("PATIENT_MERGE_ADMIN_REQUIRED")
            ? "Sólo una persona administradora puede unir fichas."
            : "No pudimos unir las fichas. Revisá antes de volver a intentar.";
        return;
      }
      props.onMerged$(
        `Unimos "${pair.duplicate.name}" en "${pair.primary.name}".`,
      );
    } catch {
      state.error =
        "No pudimos confirmar si la fusión se completó. Revisá las fichas antes de reintentar.";
    } finally {
      state.merging = "";
    }
  });

  return (
    <div class="drawer-layer" role="presentation" onClick$={props.onClose$}>
      <aside
        class="drawer duplicate-assistant"
        role="dialog"
        aria-modal="true"
        aria-labelledby="duplicate-assistant-title"
        tabIndex={-1}
        stoppropagation:click
        onKeyDown$={(event) => {
          if (event.key === "Escape" && !state.merging) props.onClose$();
        }}
      >
        <header class="drawer-header">
          <div>
            <span class="eyebrow">Pacientes</span>
            <h2 id="duplicate-assistant-title">Fichas que podrían repetirse</h2>
          </div>
          <button type="button" aria-label="Cerrar" onClick$={props.onClose$}>
            <Icon name="x" size={19} />
          </button>
        </header>

        <div class="drawer-body">
          {state.error && (
            <p class="duplicate-error" role="alert">
              {state.error}
            </p>
          )}

          {pairs.length === 0 ? (
            <p class="duplicate-empty">
              No encontramos fichas repetidas. Se comparan el teléfono y el
              nombre; siempre decidís vos.
            </p>
          ) : (
            <ul class="duplicate-list">
              {pairs.map((pair) => {
                const key = `${pair.primary.id}:${pair.duplicate.id}`;
                const block = mergeBlock(pair);
                return (
                  <li key={key}>
                    <div class="duplicate-reason">
                      <strong>{DUPLICATE_REASON_LABELS[pair.reason]}</strong>
                      <small>{pair.confidence}% de coincidencia</small>
                    </div>

                    <div class="duplicate-pair">
                      <div class="duplicate-card keep">
                        <span class="duplicate-card-label">Se conserva</span>
                        <strong>{pair.primary.name}</strong>
                        <small>
                          {pair.primary.phoneE164 ?? "Sin teléfono"}
                        </small>
                        <small>
                          {pair.primary.appointmentCount} turno
                          {pair.primary.appointmentCount === 1 ? "" : "s"}
                        </small>
                      </div>
                      <Icon name="arrow-left" size={18} />
                      <div class="duplicate-card">
                        <span class="duplicate-card-label">Se une</span>
                        <strong>{pair.duplicate.name}</strong>
                        <small>
                          {pair.duplicate.phoneE164 ?? "Sin teléfono"}
                        </small>
                        <small>
                          {pair.duplicate.appointmentCount} turno
                          {pair.duplicate.appointmentCount === 1 ? "" : "s"}
                        </small>
                      </div>
                    </div>

                    {block.blocked && (
                      <p class="duplicate-blocked">{block.reason}</p>
                    )}

                    <div class="duplicate-actions">
                      <button
                        class="secondary-button small"
                        type="button"
                        onClick$={() => {
                          dismissed.value = [...dismissed.value, key];
                        }}
                      >
                        No son la misma persona
                      </button>
                      <button
                        class="primary-button small"
                        type="button"
                        disabled={
                          block.blocked ||
                          !props.isAdmin ||
                          state.merging === key
                        }
                        onClick$={() => merge(pair)}
                      >
                        {state.merging === key ? "Uniendo…" : "Unir fichas"}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {!props.isAdmin && pairs.length > 0 && (
            <p class="duplicate-empty">
              Sólo una persona administradora puede unir fichas.
            </p>
          )}
        </div>
      </aside>
    </div>
  );
});
