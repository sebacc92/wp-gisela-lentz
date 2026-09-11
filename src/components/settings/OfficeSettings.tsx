import { component$, useContext } from "@qwik.dev/core";
import { SETTINGS_CONTEXT } from "./SettingsContext";

/** Datos del consultorio: nombre, contacto y dirección que ve el paciente. */
export const OfficeSettings = component$(() => {
  const settings = useContext(SETTINGS_CONTEXT);
  const { state } = settings;
  const saveAppSettings = settings.saveAppSettings$;

  return (
    <section class="settings-block">
      <div>
        <h2>Datos del consultorio</h2>
        <p>
          Completá solo los datos confirmados. Se usarán para identificar el
          consultorio.
        </p>
      </div>
      <div class="settings-form-grid">
        <label class="form-field">
          <span>Nombre</span>
          <input
            value={state.clinicName}
            disabled={!state.isAdmin}
            onInput$={(_, element) => (state.clinicName = element.value)}
          />
        </label>
        <label class="form-field">
          <span>Subtítulo</span>
          <input
            value={state.subtitle}
            disabled={!state.isAdmin}
            onInput$={(_, element) => (state.subtitle = element.value)}
          />
        </label>
        <label class="form-field">
          <span>
            Teléfono <em>Opcional</em>
          </span>
          <input
            inputMode="tel"
            value={state.phone}
            disabled={!state.isAdmin}
            onInput$={(_, element) => (state.phone = element.value)}
          />
        </label>
        <label class="form-field">
          <span>
            Email <em>Opcional</em>
          </span>
          <input
            type="email"
            value={state.email}
            disabled={!state.isAdmin}
            onInput$={(_, element) => (state.email = element.value)}
          />
        </label>
        <label class="form-field settings-span-2">
          <span>
            Dirección <em>Opcional</em>
          </span>
          <input
            value={state.address}
            disabled={!state.isAdmin}
            onInput$={(_, element) => (state.address = element.value)}
          />
        </label>
        <label class="form-field settings-span-2">
          <span>
            Enlace al logo <em>Opcional</em>
          </span>
          <input
            type="url"
            value={state.logoUrl}
            disabled={!state.isAdmin}
            onInput$={(_, element) => (state.logoUrl = element.value)}
          />
        </label>
        <label class="form-field settings-span-2">
          <span>Zona horaria de la agenda</span>
          <input
            value={state.timezone}
            disabled={!state.isAdmin}
            onInput$={(_, element) => (state.timezone = element.value)}
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
              clinic_name: state.clinicName.trim(),
              business_subtitle: state.subtitle.trim(),
              business_phone: state.phone.trim() || null,
              business_email: state.email.trim() || null,
              business_address: state.address.trim() || null,
              logo_url: state.logoUrl.trim() || null,
              timezone: state.timezone.trim(),
            },
            "Datos del consultorio guardados.",
          )
        }
      >
        Guardar datos
      </button>
    </section>
  );
});
