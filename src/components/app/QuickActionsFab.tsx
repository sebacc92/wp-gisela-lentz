import {
  $,
  component$,
  useContext,
  useSignal,
  useStore,
  type QRL,
} from "@qwik.dev/core";
import { APP_USER_CONTEXT } from "~/components/app/AppUserContext";
import { ManualAppointmentDrawer } from "~/components/appointments/ManualAppointmentDrawer";
import { Icon } from "~/components/ui/Icon";
import { businessDateInput } from "~/lib/date-time";
import type {
  BookingDurationSettings,
  ProfessionalOption,
  ServiceOption,
} from "~/lib/inbox-types";
import { getSupabaseClient } from "~/lib/supabase/client";
import {
  loadBookingDurationSettings,
  loadProfessionals,
  loadServices,
} from "~/lib/supabase/data";
import "./quick-actions.css";

interface QuickActionsFabProps {
  /** Avisa al inicio que algo cambió, para que vuelva a leer la agenda. */
  onChanged$: QRL<(message: string) => void>;
}

/**
 * Acciones rápidas del inicio: cargar un turno manual o cerrar un horario sin
 * salir de la pantalla.
 *
 * Los catálogos (profesionales, motivos, duraciones) se cargan recién cuando
 * se abre el turno manual. El inicio es la pantalla que más se abre en el día
 * y no tiene por qué pagar esas consultas cada vez.
 *
 * Cerrar un horario escribe en `availability_exceptions`, que por RLS es sólo
 * de ADMIN: la acción no se ofrece a quien no podría completarla.
 */
export const QuickActionsFab = component$<QuickActionsFabProps>((props) => {
  const appUser = useContext(APP_USER_CONTEXT);
  const menuOpen = useSignal(false);
  const mode = useSignal<"appointment" | "block" | null>(null);
  const loadingOptions = useSignal(false);
  const optionsError = useSignal("");

  const options = useStore<{
    professionals: ProfessionalOption[];
    services: ServiceOption[];
    bookingDurations: BookingDurationSettings;
    loaded: boolean;
  }>({
    professionals: [],
    services: [],
    bookingDurations: { iomaMinutes: 0, privateMinutes: 0 },
    loaded: false,
  });

  const block = useStore({
    date: "",
    start: "",
    end: "",
    reason: "",
    saving: false,
    error: "",
  });

  const openAppointment = $(async () => {
    menuOpen.value = false;
    optionsError.value = "";

    if (!options.loaded) {
      loadingOptions.value = true;
      try {
        const client = getSupabaseClient();
        const [professionals, services, bookingDurations] = await Promise.all([
          loadProfessionals(client),
          loadServices(client),
          loadBookingDurationSettings(client),
        ]);
        options.professionals = professionals;
        options.services = services;
        options.bookingDurations = bookingDurations;
        options.loaded = true;
      } catch {
        optionsError.value =
          "No pudimos abrir el turno manual. Revisá la conexión e intentá de nuevo.";
        return;
      } finally {
        loadingOptions.value = false;
      }
    }

    mode.value = "appointment";
  });

  const openBlock = $(() => {
    menuOpen.value = false;
    block.date = businessDateInput();
    block.start = "";
    block.end = "";
    block.reason = "";
    block.error = "";
    mode.value = "block";
  });

  const saveBlock = $(async () => {
    if (block.saving) return;
    if (!block.date) {
      block.error = "Elegí la fecha que querés cerrar.";
      return;
    }
    // Un rango a medias cerraría el día entero sin que nadie lo haya pedido.
    if (Boolean(block.start) !== Boolean(block.end)) {
      block.error =
        "Completá la hora de inicio y la de fin, o dejá las dos vacías.";
      return;
    }
    if (block.start && block.start >= block.end) {
      block.error = "La hora de fin tiene que ser posterior a la de inicio.";
      return;
    }

    const professionalId = options.professionals[0]?.id;
    let resolvedProfessionalId = professionalId;
    if (!resolvedProfessionalId) {
      try {
        const professionals = await loadProfessionals(getSupabaseClient());
        options.professionals = professionals;
        resolvedProfessionalId = professionals[0]?.id;
      } catch {
        block.error = "No pudimos identificar la agenda a cerrar.";
        return;
      }
    }
    if (!resolvedProfessionalId) {
      block.error = "No pudimos identificar la agenda a cerrar.";
      return;
    }

    block.saving = true;
    block.error = "";
    const { error } = await getSupabaseClient()
      .from("availability_exceptions")
      .insert({
        professional_id: resolvedProfessionalId,
        date: block.date,
        start_time: block.start || null,
        end_time: block.end || null,
        type: "unavailable",
        reason: block.reason.trim() || null,
      });
    block.saving = false;

    if (error) {
      block.error =
        "No pudimos cerrar el horario. Sólo un administrador puede hacerlo.";
      return;
    }

    mode.value = null;
    await props.onChanged$(
      block.start
        ? `Cerraste la agenda el ${block.date}, de ${block.start} a ${block.end}.`
        : `Cerraste la agenda todo el día del ${block.date}.`,
    );
  });

  return (
    <>
      <div class="quick-actions">
        {menuOpen.value && (
          <div
            class="quick-actions-menu"
            role="menu"
            aria-label="Acciones rápidas"
          >
            <button
              type="button"
              role="menuitem"
              disabled={loadingOptions.value}
              onClick$={openAppointment}
            >
              <Icon name="calendar" size={17} />
              {loadingOptions.value ? "Abriendo…" : "Nuevo turno"}
            </button>
            {appUser.isAdmin && (
              <button type="button" role="menuitem" onClick$={openBlock}>
                <Icon name="clock" size={17} />
                Cerrar un horario
              </button>
            )}
          </div>
        )}

        <button
          class="quick-actions-trigger"
          type="button"
          aria-expanded={menuOpen.value}
          aria-haspopup="menu"
          aria-label={
            menuOpen.value
              ? "Cerrar acciones rápidas"
              : "Abrir acciones rápidas"
          }
          onClick$={() => (menuOpen.value = !menuOpen.value)}
          onKeyDown$={(event) => {
            if (event.key === "Escape" && menuOpen.value) {
              event.preventDefault();
              menuOpen.value = false;
            }
          }}
        >
          <Icon name={menuOpen.value ? "x" : "plus"} size={23} />
        </button>
      </div>

      {optionsError.value && (
        <div class="toast" role="alert">
          <span>{optionsError.value}</span>
          <button type="button" onClick$={() => (optionsError.value = "")}>
            ×
          </button>
        </div>
      )}

      {mode.value === "appointment" && (
        <ManualAppointmentDrawer
          professionals={options.professionals}
          services={options.services}
          bookingDurations={options.bookingDurations}
          initialDate={businessDateInput()}
          onClose$={() => (mode.value = null)}
          onSaved$={$(async (message: string) => {
            mode.value = null;
            await props.onChanged$(message);
          })}
        />
      )}

      {mode.value === "block" && (
        <div
          class="drawer-layer"
          role="presentation"
          onClick$={() => {
            if (!block.saving) mode.value = null;
          }}
        >
          <aside
            class="drawer quick-block-drawer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="quick-block-title"
            aria-busy={block.saving}
            tabIndex={-1}
            stoppropagation:click
            onKeyDown$={(event) => {
              if (event.key === "Escape" && !block.saving) {
                event.preventDefault();
                mode.value = null;
              }
            }}
          >
            <header class="drawer-header">
              <div>
                <span class="eyebrow">Agenda</span>
                <h2 id="quick-block-title">Cerrar un horario</h2>
              </div>
              <button
                type="button"
                aria-label="Cerrar"
                disabled={block.saving}
                onClick$={() => (mode.value = null)}
              >
                <Icon name="x" size={19} />
              </button>
            </header>

            <div class="drawer-body">
              <p class="quick-block-help">
                Nadie va a poder reservar en ese rango. Los turnos ya
                confirmados no se cancelan solos.
              </p>

              <label class="field">
                <span>Fecha</span>
                <input
                  type="date"
                  value={block.date}
                  onInput$={(_, element) => (block.date = element.value)}
                />
              </label>

              <div class="quick-block-range">
                <label class="field">
                  <span>Desde</span>
                  <input
                    type="time"
                    value={block.start}
                    onInput$={(_, element) => (block.start = element.value)}
                  />
                </label>
                <label class="field">
                  <span>Hasta</span>
                  <input
                    type="time"
                    value={block.end}
                    onInput$={(_, element) => (block.end = element.value)}
                  />
                </label>
              </div>
              <p class="quick-block-help">
                Dejá las dos horas vacías para cerrar el día completo.
              </p>

              <label class="field">
                <span>Motivo (opcional)</span>
                <input
                  type="text"
                  maxLength={120}
                  value={block.reason}
                  onInput$={(_, element) => (block.reason = element.value)}
                />
              </label>

              {block.error && (
                <p class="quick-block-error" role="alert">
                  {block.error}
                </p>
              )}
            </div>

            <div class="drawer-form-actions">
              <button
                class="secondary-button"
                type="button"
                disabled={block.saving}
                onClick$={() => (mode.value = null)}
              >
                Cancelar
              </button>
              <button
                class="primary-button"
                type="button"
                disabled={block.saving}
                onClick$={saveBlock}
              >
                {block.saving ? "Cerrando…" : "Cerrar este horario"}
              </button>
            </div>
          </aside>
        </div>
      )}
    </>
  );
});
