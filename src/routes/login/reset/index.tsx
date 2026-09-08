import { component$, useSignal, useVisibleTask$ } from "@qwik.dev/core";
import type { DocumentHead } from "@qwik.dev/router";
import { useNavigate } from "@qwik.dev/router";
import { BusinessLogo } from "~/components/brand/BusinessLogo";
import { Icon } from "~/components/ui/Icon";
import {
  APP_DESCRIPTION,
  BUSINESS_CONFIG,
  getPageTitle,
} from "~/config/business";
import {
  authLinkHasError,
  PASSWORD_MIN_LENGTH,
  passwordAuthCallback,
  validateNewPassword,
} from "~/lib/password-recovery";
import { getSupabaseClient, isSupabaseConfigured } from "~/lib/supabase/client";

type RecoveryState =
  | "checking"
  | "ready"
  | "invalid"
  | "unavailable"
  | "saving";
const CONFIGURATION_ERROR_MESSAGE =
  "El acceso no está disponible por un problema de configuración. Intentá nuevamente más tarde.";

export default component$(() => {
  const navigate = useNavigate();
  const password = useSignal("");
  const confirmation = useSignal("");
  const visible = useSignal(false);
  const configured = isSupabaseConfigured();
  const state = useSignal<RecoveryState>(
    configured ? "checking" : "unavailable",
  );
  const error = useSignal(configured ? "" : CONFIGURATION_ERROR_MESSAGE);

  useVisibleTask$(async ({ cleanup }) => {
    if (!configured) {
      error.value = CONFIGURATION_ERROR_MESSAGE;
      state.value = "unavailable";
      return;
    }
    const callbackUrl = new URL(window.location.href);
    const authCallback = passwordAuthCallback(callbackUrl);
    if (authLinkHasError(callbackUrl) || !authCallback) {
      state.value = "invalid";
      return;
    }

    try {
      const client = getSupabaseClient();
      let acceptedAuthCallback = false;
      const acceptCallbackSession = (accessToken: string): boolean => {
        if (
          state.value !== "checking" ||
          accessToken !== authCallback.accessToken
        ) {
          return false;
        }

        acceptedAuthCallback = true;
        state.value = "ready";
        window.history.replaceState(window.history.state, "", "/login/reset/");
        return true;
      };
      const {
        data: { subscription },
      } = client.auth.onAuthStateChange((event, session) => {
        const acceptedEvent =
          (authCallback.action === "recovery" &&
            event === "PASSWORD_RECOVERY") ||
          (authCallback.action === "invite" && event === "SIGNED_IN");
        if (
          !acceptedEvent ||
          !session ||
          !acceptCallbackSession(session.access_token)
        ) {
          return;
        }
      });
      cleanup(() => subscription.unsubscribe());

      const {
        data: { session },
        error: sessionError,
      } = await client.auth.getSession();
      if (!sessionError && session) {
        acceptCallbackSession(session.access_token);
      }
      if (!acceptedAuthCallback) state.value = "invalid";
    } catch {
      error.value =
        "No pudimos validar el enlace. Revisá la conexión y volvé a abrir el enlace del email.";
      state.value = "unavailable";
    }
  });

  return (
    <main class="login-page">
      <section
        class="login-panel"
        aria-labelledby="password-reset-title"
        aria-describedby="password-reset-description"
      >
        <div class="login-brand">
          <BusinessLogo />
        </div>

        <div class="login-heading">
          <span class="eyebrow">Acceso seguro</span>
          <h1 id="password-reset-title">Elegí tu contraseña</h1>
          <p id="password-reset-description">
            Este enlace sirve tanto para una invitación como para recuperar tu
            acceso.
          </p>
        </div>

        {state.value === "checking" ? (
          <div class="login-recovery-state" aria-live="polite">
            <span class="small-spinner" aria-hidden="true" />
            <p>Validando el enlace…</p>
          </div>
        ) : state.value === "invalid" || state.value === "unavailable" ? (
          <div class="login-recovery-state" role="alert">
            <Icon name="info" size={20} />
            <strong>
              {state.value === "unavailable"
                ? "No pudimos validar el acceso."
                : "El enlace no es válido o ya venció."}
            </strong>
            <p>
              {state.value === "unavailable"
                ? error.value
                : "Pedí uno nuevo desde la pantalla de ingreso."}
            </p>
            <button
              class="primary-button login-submit"
              type="button"
              onClick$={() => navigate("/login")}
            >
              Volver a ingresar
            </button>
          </div>
        ) : (
          <form
            class="login-form"
            aria-busy={state.value === "saving"}
            preventdefault:submit
            onSubmit$={async () => {
              if (!configured) {
                error.value = CONFIGURATION_ERROR_MESSAGE;
                state.value = "unavailable";
                return;
              }
              if (state.value !== "ready") return;
              error.value = validateNewPassword(
                password.value,
                confirmation.value,
              );
              if (error.value) return;

              state.value = "saving";
              try {
                const { error: updateError } =
                  await getSupabaseClient().auth.updateUser({
                    password: password.value,
                  });
                if (updateError) {
                  error.value =
                    "No pudimos guardar la contraseña. Pedí un enlace nuevo e intentá otra vez.";
                  return;
                }
              } catch {
                error.value =
                  "No pudimos guardar la contraseña. Revisá la conexión e intentá nuevamente.";
                return;
              } finally {
                state.value = "ready";
              }

              password.value = "";
              confirmation.value = "";
              try {
                await navigate("/app");
              } catch {
                error.value =
                  "La contraseña se guardó, pero no pudimos abrir el panel. Volvé a ingresar con tu contraseña nueva.";
              }
            }}
          >
            <label>
              <span>Contraseña nueva</span>
              <div class="password-field">
                <input
                  id="new-password"
                  required
                  type={visible.value ? "text" : "password"}
                  value={password.value}
                  minLength={PASSWORD_MIN_LENGTH}
                  autocomplete="new-password"
                  aria-describedby={
                    error.value ? "password-reset-error" : undefined
                  }
                  placeholder={`Al menos ${PASSWORD_MIN_LENGTH} caracteres`}
                  onInput$={(_, element) => {
                    password.value = element.value;
                    if (error.value) error.value = "";
                  }}
                />
                <button
                  type="button"
                  aria-controls="new-password password-confirmation"
                  aria-label={
                    visible.value
                      ? "Ocultar contraseñas"
                      : "Mostrar contraseñas"
                  }
                  aria-pressed={visible.value}
                  onClick$={() => (visible.value = !visible.value)}
                >
                  {visible.value ? "Ocultar" : "Ver"}
                </button>
              </div>
            </label>
            <label>
              <span>Repetir contraseña</span>
              <input
                id="password-confirmation"
                required
                type={visible.value ? "text" : "password"}
                value={confirmation.value}
                minLength={PASSWORD_MIN_LENGTH}
                autocomplete="new-password"
                aria-describedby={
                  error.value ? "password-reset-error" : undefined
                }
                placeholder="Repetí la contraseña"
                onInput$={(_, element) => {
                  confirmation.value = element.value;
                  if (error.value) error.value = "";
                }}
              />
            </label>
            {error.value && (
              <p id="password-reset-error" class="login-error" role="alert">
                {error.value}
              </p>
            )}
            <button
              class="primary-button login-submit"
              type="submit"
              disabled={!configured || state.value === "saving"}
            >
              {state.value === "saving" && (
                <span class="button-spinner" aria-hidden="true" />
              )}
              {state.value === "saving" ? "Guardando…" : "Guardar y entrar"}
            </button>
          </form>
        )}

        <div class="login-help">
          <Icon name="info" size={16} />
          <span>No compartas este enlace ni tu contraseña.</span>
        </div>
      </section>

      <aside class="login-context" aria-label="Información de la plataforma">
        <div>
          <span class="context-kicker">Odontología cercana</span>
          <h2>{BUSINESS_CONFIG.tagline}</h2>
          <p>
            Agenda, mensajes y pacientes organizados para que sepas siempre qué
            hacer a continuación.
          </p>
          <ul>
            <li>
              <Icon name="check-circle" size={18} /> Acceso protegido por un
              enlace personal
            </li>
            <li>
              <Icon name="check-circle" size={18} /> Tu contraseña no se guarda
              en este formulario
            </li>
            <li>
              <Icon name="check-circle" size={18} /> El enlace deja de servir
              cuando vence
            </li>
          </ul>
        </div>
        <small>
          {BUSINESS_CONFIG.name} · {BUSINESS_CONFIG.subtitle}
        </small>
      </aside>
    </main>
  );
});

export const head: DocumentHead = {
  title: getPageTitle("Elegir contraseña"),
  meta: [
    { name: "description", content: APP_DESCRIPTION },
    { name: "robots", content: "noindex, nofollow, noarchive" },
  ],
};
