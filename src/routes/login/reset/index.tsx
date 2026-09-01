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
import { getSupabaseClient } from "~/lib/supabase/client";

type RecoveryState = "checking" | "ready" | "invalid" | "saving";

export default component$(() => {
  const navigate = useNavigate();
  const password = useSignal("");
  const confirmation = useSignal("");
  const visible = useSignal(false);
  const state = useSignal<RecoveryState>("checking");
  const error = useSignal("");

  useVisibleTask$(async ({ cleanup }) => {
    const callbackUrl = new URL(window.location.href);
    const authCallback = passwordAuthCallback(callbackUrl);
    if (authLinkHasError(callbackUrl) || !authCallback) {
      state.value = "invalid";
      return;
    }

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
        (authCallback.action === "recovery" && event === "PASSWORD_RECOVERY") ||
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
        ) : state.value === "invalid" ? (
          <div class="login-recovery-state" role="alert">
            <Icon name="info" size={20} />
            <strong>El enlace no es válido o ya venció.</strong>
            <p>Pedí uno nuevo desde la pantalla de ingreso.</p>
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
              error.value = validateNewPassword(
                password.value,
                confirmation.value,
              );
              if (error.value) return;

              state.value = "saving";
              const { error: updateError } =
                await getSupabaseClient().auth.updateUser({
                  password: password.value,
                });
              if (updateError) {
                error.value =
                  "No pudimos guardar la contraseña. Pedí un enlace nuevo e intentá otra vez.";
                state.value = "ready";
                return;
              }

              password.value = "";
              confirmation.value = "";
              await navigate("/app");
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
              disabled={state.value === "saving"}
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
