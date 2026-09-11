import { component$, useContext, useSignal } from "@qwik.dev/core";
import { ManualHelpLink } from "~/components/app/ManualHelpLink";
import { getSupabaseClient } from "~/lib/supabase/client";
import { SETTINGS_CONTEXT } from "./SettingsContext";

/** Reglas de turnos y motivos de atención configurables. */
export const AppointmentsSettings = component$(() => {
  const settings = useContext(SETTINGS_CONTEXT);
  const { state, notice } = settings;
  const saveAppSettings = settings.saveAppSettings$;
  const loadSettings = settings.reload$;
  const newServiceName = useSignal("");
  const newServiceDescription = useSignal("");

  return (
    <div class="settings-stack">
      <section class="settings-block">
        <div>
          <h2>Reglas de turnos</h2>
          <p>
            Ajustá el descanso entre pacientes y con cuánta anticipación se
            puede reservar.
          </p>
          <ManualHelpLink
            section="turnos"
            label="¿Cómo funcionan los turnos?"
          />
        </div>
        <div class="settings-form-grid">
          <label class="form-field">
            <span>Descanso entre turnos (minutos)</span>
            <input
              type="number"
              min={0}
              max={120}
              value={state.bufferMinutes}
              disabled={!state.isAdmin}
              onInput$={(_, element) =>
                (state.bufferMinutes = Number(element.value))
              }
            />
          </label>
          <label class="form-field">
            <span>Tiempo mínimo para reservar (minutos)</span>
            <input
              type="number"
              min={0}
              max={43200}
              value={state.minimumNoticeMinutes}
              disabled={!state.isAdmin}
              onInput$={(_, element) =>
                (state.minimumNoticeMinutes = Number(element.value))
              }
            />
          </label>
        </div>
        <button
          class="primary-button"
          type="button"
          disabled={!state.isAdmin}
          onClick$={() =>
            saveAppSettings(
              {
                appointment_buffer_minutes: state.bufferMinutes,
                minimum_booking_notice_minutes: state.minimumNoticeMinutes,
              },
              "Reglas de turnos guardadas.",
            )
          }
        >
          Guardar tiempos
        </button>
      </section>
      <section class="settings-block">
        <div>
          <h2>Servicios</h2>
          <p>
            Escribí los motivos de atención que querés ofrecer. La duración se
            toma automáticamente de IOMA o Particular.
          </p>
        </div>
        <div class="settings-record-list service-settings-list">
          {state.services.map((service) => (
            <div key={service.id}>
              <span>
                <input
                  aria-label={`Nombre de ${service.name}`}
                  value={service.name}
                  disabled={!state.isAdmin}
                  onInput$={(_, element) => (service.name = element.value)}
                />
                <input
                  aria-label={`Descripción de ${service.name}`}
                  value={service.description ?? ""}
                  placeholder="Descripción opcional"
                  disabled={!state.isAdmin}
                  onInput$={(_, element) =>
                    (service.description = element.value.trimStart() || null)
                  }
                />
                <small>
                  Duración automática · posición en la lista
                  <input
                    aria-label={`Orden de ${service.name}`}
                    type="number"
                    min={0}
                    max={10000}
                    value={service.sort_order}
                    disabled={!state.isAdmin}
                    onInput$={(_, element) =>
                      (service.sort_order = Number(element.value))
                    }
                  />
                </small>
              </span>
              <span class="record-actions">
                <button
                  type="button"
                  disabled={!state.isAdmin}
                  onClick$={async () => {
                    const { error } = await getSupabaseClient()
                      .from("services")
                      .update({
                        name: service.name.trim(),
                        description: service.description?.trim() || null,
                        sort_order: service.sort_order,
                      })
                      .eq("id", service.id);
                    notice.value = error
                      ? "No pudimos guardar el servicio."
                      : "Servicio guardado.";
                  }}
                >
                  Guardar
                </button>
                <button
                  type="button"
                  disabled={!state.isAdmin}
                  onClick$={async () => {
                    if (
                      service.active &&
                      !globalThis.confirm(
                        `¿Desactivar “${service.name}”? Ya no se ofrecerá para turnos nuevos.`,
                      )
                    )
                      return;
                    const { error } = await getSupabaseClient()
                      .from("services")
                      .update({ active: !service.active })
                      .eq("id", service.id);
                    if (!error) {
                      service.active = !service.active;
                      notice.value = service.active
                        ? "Servicio activado."
                        : "Servicio desactivado.";
                    } else {
                      notice.value = "No pudimos cambiar el servicio.";
                    }
                  }}
                >
                  {service.active ? "Desactivar" : "Activar"}
                </button>
                <button
                  type="button"
                  disabled={!state.isAdmin}
                  onClick$={async () => {
                    if (
                      !globalThis.confirm(
                        `¿Eliminar “${service.name}”? Si ya tiene turnos, no podrá eliminarse y conviene desactivarlo.`,
                      )
                    )
                      return;
                    const { error } = await getSupabaseClient()
                      .from("services")
                      .delete()
                      .eq("id", service.id);
                    if (error)
                      notice.value =
                        "No se puede eliminar porque tiene turnos asociados. Podés desactivarlo.";
                    else {
                      await loadSettings();
                      notice.value = "Servicio eliminado.";
                    }
                  }}
                >
                  Eliminar
                </button>
              </span>
            </div>
          ))}
        </div>
        <div class="settings-inline-form">
          <label class="form-field">
            <span>Nombre</span>
            <input
              value={newServiceName.value}
              placeholder="Ej. Consulta"
              disabled={!state.isAdmin}
              onInput$={(_, element) => (newServiceName.value = element.value)}
            />
          </label>
          <label class="form-field">
            <span>
              Descripción <em>Opcional</em>
            </span>
            <input
              value={newServiceDescription.value}
              placeholder="Ej. Primera visita o control"
              disabled={!state.isAdmin}
              onInput$={(_, element) =>
                (newServiceDescription.value = element.value)
              }
            />
          </label>
          <button
            class="primary-button"
            type="button"
            disabled={!state.isAdmin || !newServiceName.value.trim()}
            onClick$={async () => {
              const { error } = await getSupabaseClient()
                .from("services")
                .insert({
                  name: newServiceName.value.trim(),
                  description: newServiceDescription.value.trim() || null,
                  // Campo legado requerido por la tabla. La reserva
                  // real usa la duración configurada por cobertura.
                  duration_minutes: state.defaultDuration,
                  sort_order:
                    Math.max(
                      0,
                      ...state.services.map((service) => service.sort_order),
                    ) + 10,
                });
              if (error) notice.value = "No pudimos crear el servicio.";
              else {
                newServiceName.value = "";
                newServiceDescription.value = "";
                await loadSettings();
                notice.value = "Servicio agregado.";
              }
            }}
          >
            Agregar servicio
          </button>
        </div>
      </section>
    </div>
  );
});
