import { component$, useContext } from "@qwik.dev/core";
import { SETTINGS_CONTEXT } from "./SettingsContext";

/** Personas con acceso al panel. El alta y la baja se gestionan aparte. */
export const UsersSettings = component$(() => {
  const settings = useContext(SETTINGS_CONTEXT);
  const { state } = settings;

  return (
    <section class="settings-block">
      <div>
        <h2>Personas con acceso</h2>
        <p>Estas son las únicas personas que pueden entrar al sistema.</p>
      </div>
      {!state.isAdmin ? (
        <p class="settings-note">
          Esta sección está disponible únicamente para administradores.
        </p>
      ) : (
        <div class="settings-record-list">
          {state.users.map((user) => (
            <div key={user.id}>
              <span>
                <strong>{user.full_name}</strong>
                <small>
                  {user.role === "ADMIN" ? "Administradora" : "Operadora"}
                </small>
              </span>
              <span>{user.active ? "Activo" : "Inactivo"}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
});
