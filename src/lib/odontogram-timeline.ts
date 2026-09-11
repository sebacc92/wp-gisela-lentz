import { currentByTooth, type OdontogramEntry } from "./odontogram.ts";

/**
 * Línea de tiempo del odontograma.
 *
 * No hace falta guardar fotos: la ficha es append-only, así que el estado en
 * cualquier momento se reconstruye tomando los asientos hasta esa secuencia.
 * Eso también significa que la línea de tiempo no puede mostrar algo que no
 * haya quedado registrado; nunca interpola ni supone.
 */

export interface TimelinePoint {
  /** Secuencia del último asiento incluido en esta parada. */
  sequence: number;
  recordedAt: string;
  /** Cuántos asientos entraron ese día. */
  entryCount: number;
}

/**
 * Una parada por día con actividad, de la más vieja a la más nueva. Agrupar
 * por día evita una línea de tiempo con veinte paradas de la misma sesión.
 */
export function timelinePoints(
  entries: readonly OdontogramEntry[],
): TimelinePoint[] {
  const byDay = new Map<string, TimelinePoint>();

  for (const entry of entries) {
    const day = entry.recordedAt.slice(0, 10);
    const existing = byDay.get(day);
    if (!existing) {
      byDay.set(day, {
        sequence: entry.entrySequence,
        recordedAt: entry.recordedAt,
        entryCount: 1,
      });
      continue;
    }
    existing.entryCount += 1;
    // La parada del día representa cómo quedó la ficha al terminar ese día.
    if (entry.entrySequence > existing.sequence) {
      existing.sequence = entry.entrySequence;
      existing.recordedAt = entry.recordedAt;
    }
  }

  return [...byDay.values()].sort((a, b) => a.sequence - b.sequence);
}

/** Estado de cada pieza considerando sólo los asientos hasta `sequence`. */
export function snapshotAt(
  entries: readonly OdontogramEntry[],
  sequence: number,
): Map<number, OdontogramEntry> {
  return currentByTooth(
    entries.filter((entry) => entry.entrySequence <= sequence),
  );
}

export interface ToothChange {
  tooth: number;
  before: OdontogramEntry | undefined;
  after: OdontogramEntry | undefined;
}

/**
 * Qué piezas cambiaron entre dos paradas. Es lo que se quiere ver al comparar:
 * no la ficha entera, sino qué se movió.
 */
export function changesBetween(
  entries: readonly OdontogramEntry[],
  fromSequence: number,
  toSequence: number,
): ToothChange[] {
  const before = snapshotAt(entries, fromSequence);
  const after = snapshotAt(entries, toSequence);
  const teeth = new Set([...before.keys(), ...after.keys()]);

  const changes: ToothChange[] = [];
  for (const tooth of teeth) {
    const previous = before.get(tooth);
    const next = after.get(tooth);
    if (previous?.id === next?.id) continue;
    changes.push({ tooth, before: previous, after: next });
  }
  return changes.sort((a, b) => a.tooth - b.tooth);
}
