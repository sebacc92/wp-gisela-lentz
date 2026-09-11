import { component$, useContext, useSignal } from "@qwik.dev/core";
import { ManualHelpLink } from "~/components/app/ManualHelpLink";
import { getSupabaseClient } from "~/lib/supabase/client";
import { SETTINGS_CONTEXT } from "./SettingsContext";
import { cleanTime, formatSettingsDate, weekdays } from "./settings-format";

/** Horario semanal y días u horarios cerrados excepcionalmente. */
export const HoursSettings = component$(() => {
  const settings = useContext(SETTINGS_CONTEXT);
  const { state, notice } = settings;
  const loadSettings = settings.reload$;
  const newRuleWeekday = useSignal(1);
  const newRuleStart = useSignal("09:00");
  const newRuleEnd = useSignal("13:00");
  const newBlockDate = useSignal("");
  const newBlockStart = useSignal("");
  const newBlockEnd = useSignal("");
  const newBlockReason = useSignal("");

  return (
    <div class="settings-stack">
      <section class="settings-block">
        <div>
          <h2>Horarios de atención</h2>
          <p>
            Cargá los días y horas en los que se pueden dar turnos. Si atendés
            mañana y tarde, agregá dos horarios para ese día.
          </p>
          <ManualHelpLink
            section="turnos"
            label="¿Cómo afectan los horarios a los turnos?"
          />
        </div>
        <div class="settings-record-list">
          {state.rules.length ? (
            state.rules.map((rule) => (
              <div key={rule.id}>
                <span>
                  <strong>{weekdays[rule.weekday]}</strong>
                  <small>
                    {cleanTime(rule.start_time)}–{cleanTime(rule.end_time)} ·
                    turnos cada {rule.slot_minutes} minutos ·{" "}
                    {rule.active ? "abierto" : "cerrado"}
                  </small>
                </span>
                <span class="record-actions">
                  <button
                    type="button"
                    disabled={!state.isAdmin}
                    onClick$={async () => {
                      if (
                        rule.active &&
                        !globalThis.confirm(
                          `¿Cerrar el horario del ${weekdays[rule.weekday]} de ${cleanTime(rule.start_time)} a ${cleanTime(rule.end_time)}? No aparecerá para turnos nuevos.`,
                        )
                      )
                        return;
                      const { error } = await getSupabaseClient()
                        .from("availability_rules")
                        .update({ active: !rule.active })
                        .eq("id", rule.id);
                      if (!error) {
                        rule.active = !rule.active;
                        notice.value = rule.active
                          ? "El horario volvió a estar disponible."
                          : "El horario quedó cerrado.";
                      } else notice.value = "No pudimos cambiar el horario.";
                    }}
                  >
                    {rule.active ? "Cerrar este horario" : "Volver a abrir"}
                  </button>
                  <button
                    type="button"
                    disabled={!state.isAdmin}
                    onClick$={async () => {
                      if (
                        !globalThis.confirm(
                          `¿Eliminar el horario del ${weekdays[rule.weekday]} de ${cleanTime(rule.start_time)} a ${cleanTime(rule.end_time)}?`,
                        )
                      )
                        return;
                      const { error } = await getSupabaseClient()
                        .from("availability_rules")
                        .delete()
                        .eq("id", rule.id);
                      if (!error) {
                        await loadSettings();
                        notice.value = "Horario eliminado.";
                      } else notice.value = "No pudimos eliminar la franja.";
                    }}
                  >
                    Eliminar
                  </button>
                </span>
              </div>
            ))
          ) : (
            <p class="settings-note">
              Todavía no hay horarios. Agregá el primero debajo.
            </p>
          )}
        </div>
        <div class="settings-inline-form settings-hours-form">
          <label class="form-field">
            <span>Día</span>
            <select
              value={newRuleWeekday.value}
              disabled={!state.isAdmin}
              onChange$={(_, element) =>
                (newRuleWeekday.value = Number(element.value))
              }
            >
              {weekdays.map((day, index) => (
                <option key={day} value={index}>
                  {day}
                </option>
              ))}
            </select>
          </label>
          <label class="form-field">
            <span>Desde</span>
            <input
              type="time"
              value={newRuleStart.value}
              disabled={!state.isAdmin}
              onInput$={(_, element) => (newRuleStart.value = element.value)}
            />
          </label>
          <label class="form-field">
            <span>Hasta</span>
            <input
              type="time"
              value={newRuleEnd.value}
              disabled={!state.isAdmin}
              onInput$={(_, element) => (newRuleEnd.value = element.value)}
            />
          </label>
          <button
            class="primary-button"
            type="button"
            disabled={
              !state.isAdmin ||
              !state.professionalId ||
              newRuleStart.value >= newRuleEnd.value
            }
            onClick$={async () => {
              if (
                !globalThis.confirm(
                  `¿Agregar este horario? ${weekdays[newRuleWeekday.value]}, de ${newRuleStart.value} a ${newRuleEnd.value}.`,
                )
              )
                return;
              const { error } = await getSupabaseClient()
                .from("availability_rules")
                .insert({
                  professional_id: state.professionalId,
                  weekday: newRuleWeekday.value,
                  start_time: newRuleStart.value,
                  end_time: newRuleEnd.value,
                  slot_minutes: state.defaultDuration,
                });
              if (error) notice.value = "No pudimos agregar la franja.";
              else {
                await loadSettings();
                notice.value = "Horario agregado.";
              }
            }}
          >
            Agregar horario
          </button>
        </div>
      </section>

      <section class="settings-block">
        <div>
          <h2>Días y horarios cerrados</h2>
          <p>
            Usá esta opción para feriados, vacaciones o momentos en los que no
            vas a atender.
          </p>
        </div>
        <div class="settings-record-list">
          {state.blocks.length ? (
            state.blocks.map((block) => (
              <div key={block.id}>
                <span>
                  <strong>
                    {new Intl.DateTimeFormat("es-AR", {
                      dateStyle: "medium",
                      timeZone: "UTC",
                    }).format(new Date(`${block.date}T12:00:00Z`))}
                  </strong>
                  <small>
                    {block.start_time && block.end_time
                      ? `${cleanTime(block.start_time)}–${cleanTime(block.end_time)}`
                      : "Día completo"}
                    {block.reason ? ` · ${block.reason}` : ""}
                  </small>
                </span>
                <button
                  type="button"
                  disabled={!state.isAdmin}
                  onClick$={async () => {
                    if (
                      !globalThis.confirm(
                        "¿Quitar este cierre? Ese horario volverá a estar disponible para dar turnos.",
                      )
                    )
                      return;
                    const { error } = await getSupabaseClient()
                      .from("availability_exceptions")
                      .delete()
                      .eq("id", block.id);
                    if (!error) {
                      await loadSettings();
                      notice.value = "El horario volvió a estar disponible.";
                    } else notice.value = "No pudimos eliminar el bloqueo.";
                  }}
                >
                  Quitar cierre
                </button>
              </div>
            ))
          ) : (
            <p class="settings-note">
              No hay días ni horarios cerrados próximamente.
            </p>
          )}
        </div>
        <div class="settings-inline-form settings-block-form">
          <label class="form-field">
            <span>Fecha</span>
            <input
              type="date"
              value={newBlockDate.value}
              disabled={!state.isAdmin}
              onInput$={(_, element) => (newBlockDate.value = element.value)}
            />
          </label>
          <label class="form-field">
            <span>
              Desde <em>Opcional</em>
            </span>
            <input
              type="time"
              value={newBlockStart.value}
              disabled={!state.isAdmin}
              onInput$={(_, element) => (newBlockStart.value = element.value)}
            />
          </label>
          <label class="form-field">
            <span>
              Hasta <em>Opcional</em>
            </span>
            <input
              type="time"
              value={newBlockEnd.value}
              disabled={!state.isAdmin}
              onInput$={(_, element) => (newBlockEnd.value = element.value)}
            />
          </label>
          <label class="form-field">
            <span>
              Motivo <em>Opcional</em>
            </span>
            <input
              value={newBlockReason.value}
              disabled={!state.isAdmin}
              onInput$={(_, element) => (newBlockReason.value = element.value)}
            />
          </label>
          <button
            class="primary-button"
            type="button"
            disabled={
              !state.isAdmin ||
              !state.professionalId ||
              !newBlockDate.value ||
              Boolean(newBlockStart.value) !== Boolean(newBlockEnd.value) ||
              (Boolean(newBlockStart.value) &&
                newBlockStart.value >= newBlockEnd.value)
            }
            onClick$={async () => {
              const selectedDate = formatSettingsDate(newBlockDate.value);
              const closureDescription = newBlockStart.value
                ? `el ${selectedDate}, de ${newBlockStart.value} a ${newBlockEnd.value}`
                : `durante todo el día del ${selectedDate}`;
              if (
                !globalThis.confirm(`¿Cerrar la agenda ${closureDescription}?`)
              )
                return;
              const { error } = await getSupabaseClient()
                .from("availability_exceptions")
                .insert({
                  professional_id: state.professionalId,
                  date: newBlockDate.value,
                  start_time: newBlockStart.value || null,
                  end_time: newBlockEnd.value || null,
                  type: "unavailable",
                  reason: newBlockReason.value.trim() || null,
                });
              if (error) notice.value = "No pudimos crear el bloqueo.";
              else {
                newBlockDate.value = "";
                newBlockStart.value = "";
                newBlockEnd.value = "";
                newBlockReason.value = "";
                await loadSettings();
                notice.value = "Bloqueo agregado.";
              }
            }}
          >
            Cerrar este horario
          </button>
        </div>
      </section>
    </div>
  );
});
