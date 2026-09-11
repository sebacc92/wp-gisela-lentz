import { component$, useSignal } from "@qwik.dev/core";
import { Icon } from "~/components/ui/Icon";
import { formatBusinessDate } from "~/lib/date-time";
import { CONDITION_LABELS, type OdontogramEntry } from "~/lib/odontogram";
import { changesBetween, timelinePoints } from "~/lib/odontogram-timeline";
import "./odontogram-timeline.css";

interface Props {
  entries: OdontogramEntry[];
}

/**
 * Comparación de la ficha en el tiempo.
 *
 * No guarda fotos: como el odontograma es append-only, el estado de cualquier
 * día se reconstruye tomando los asientos hasta esa secuencia. Muestra sólo lo
 * que cambió entre dos paradas, que es la pregunta real ("¿qué se hizo desde
 * marzo?"), y nunca interpola: si algo no quedó registrado, no aparece.
 */
export const OdontogramTimeline = component$<Props>(({ entries }) => {
  const points = timelinePoints(entries);
  // Arranca comparando la anteúltima parada con la última.
  const fromIndex = useSignal(Math.max(0, points.length - 2));

  if (points.length < 2) {
    return (
      <section class="odontogram-timeline">
        <h2>Cómo cambió la ficha</h2>
        <p class="odontogram-timeline-empty">
          Hace falta al menos un segundo día con registros para poder comparar.
        </p>
      </section>
    );
  }

  const safeFrom = Math.min(fromIndex.value, points.length - 2);
  const from = points[safeFrom];
  const to = points[points.length - 1];
  const changes = changesBetween(entries, from.sequence, to.sequence);

  const label = (value: string) =>
    formatBusinessDate(new Date(value), { dateStyle: "medium" });

  return (
    <section class="odontogram-timeline" aria-labelledby="timeline-title">
      <h2 id="timeline-title">Cómo cambió la ficha</h2>
      <p class="odontogram-timeline-lead">
        Compará el estado actual contra un día anterior. Se reconstruye de los
        asientos registrados; no se inventa nada entre medio.
      </p>

      <label class="odontogram-timeline-slider">
        <span>
          Desde <strong>{label(from.recordedAt)}</strong> hasta{" "}
          <strong>{label(to.recordedAt)}</strong>
        </span>
        <input
          type="range"
          min={0}
          max={points.length - 2}
          step={1}
          value={safeFrom}
          aria-label="Día con el que comparar"
          onInput$={(_, element) => (fromIndex.value = Number(element.value))}
        />
        <span class="odontogram-timeline-scale" aria-hidden="true">
          <small>{label(points[0].recordedAt)}</small>
          <small>{label(points[points.length - 2].recordedAt)}</small>
        </span>
      </label>

      {changes.length === 0 ? (
        <p class="odontogram-timeline-empty">
          No hubo cambios entre esas dos fechas.
        </p>
      ) : (
        <ul class="odontogram-timeline-changes">
          {changes.map((change) => (
            <li key={change.tooth}>
              <span class="odontogram-timeline-tooth">{change.tooth}</span>
              <span class="odontogram-timeline-transition">
                <small>
                  {change.before
                    ? CONDITION_LABELS[change.before.condition]
                    : "Sin registrar"}
                </small>
                <Icon name="arrow-left" size={14} />
                <strong>
                  {change.after
                    ? CONDITION_LABELS[change.after.condition]
                    : "Sin registrar"}
                </strong>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
});
