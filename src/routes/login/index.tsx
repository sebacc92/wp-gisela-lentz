import { component$, useSignal, useVisibleTask$ } from "@qwik.dev/core";
import type { DocumentHead } from "@qwik.dev/router";
import { useLocation, useNavigate } from "@qwik.dev/router";
import { BusinessLogo } from "~/components/brand/BusinessLogo";
import { Icon } from "~/components/ui/Icon";
import {
  APP_DESCRIPTION,
  BUSINESS_CONFIG,
  getPageTitle,
} from "~/config/business";
import {
  PASSWORD_RECOVERY_SENT_MESSAGE,
  passwordResetRedirectUrl,
} from "~/lib/password-recovery";
import { getSupabaseClient } from "~/lib/supabase/client";

function safeLoginDestination(raw: string | null, currentUrl: URL): string {
  if (!raw || raw.includes("\\")) return "/app";
  try {
    const candidate = new URL(raw, currentUrl);
    const insideApp =
      candidate.pathname === "/app" || candidate.pathname.startsWith("/app/");
    if (candidate.origin !== currentUrl.origin || !insideApp) return "/app";
    return `${candidate.pathname}${candidate.search}${candidate.hash}`;
  } catch {
    return "/app";
  }
}

export default component$(() => {
  const navigate = useNavigate();
  const location = useLocation();
  const email = useSignal("");
  const password = useSignal("");
  const visible = useSignal(false);
  const loading = useSignal(false);
  const recoveryLoading = useSignal(false);
  const recoveryMessage = useSignal("");
  const error = useSignal("");
  const destination = safeLoginDestination(
    location.url.searchParams.get("next"),
    location.url,
  );

  useVisibleTask$(async () => {
    if (location.url.searchParams.get("error") === "inactive") {
      error.value =
        "Tu acceso está inactivo. Consultá con la persona administradora.";
    }
    const {
      data: { session },
    } = await getSupabaseClient().auth.getSession();
    if (session) await navigate(destination);
  });

  return (
    <main class="login-page">
      <section
        class="login-panel"
        aria-labelledby="login-title"
        aria-describedby="login-description"
      >
        <div class="login-brand">
          <BusinessLogo />
        </div>

        <div class="login-heading">
          <span class="eyebrow">Acceso al consultorio</span>
          <h1 id="login-title">Hola, {BUSINESS_CONFIG.name.split(" ")[0]}</h1>
          <p id="login-description">
            Ingresá con tu email y contraseña para empezar.
          </p>
        </div>

        <form
          class="login-form"
          aria-busy={loading.value || recoveryLoading.value}
          preventdefault:submit
          onSubmit$={async () => {
            loading.value = true;
            error.value = "";
            const { error: signInError } =
              await getSupabaseClient().auth.signInWithPassword({
                email: email.value.trim(),
                password: password.value,
              });

            if (signInError) {
              error.value =
                signInError.message === "Invalid login credentials"
                  ? "El email o la contraseña no son correctos."
                  : "No pudimos iniciar sesión. Intentá nuevamente.";
              loading.value = false;
              return;
            }

            await navigate(destination);
          }}
        >
          <label>
            <span>Email</span>
            <input
              id="login-email"
              required
              type="email"
              value={email.value}
              autocomplete="email"
              autocapitalize="none"
              inputMode="email"
              spellcheck={false}
              aria-invalid={
                error.value === "El email o la contraseña no son correctos."
              }
              aria-describedby={error.value ? "login-error" : undefined}
              placeholder="tu@email.com"
              onInput$={(_, element) => {
                email.value = element.value;
                if (error.value) error.value = "";
                if (recoveryMessage.value) recoveryMessage.value = "";
              }}
            />
          </label>
          <label>
            <span>Contraseña</span>
            <div class="password-field">
              <input
                id="login-password"
                required
                type={visible.value ? "text" : "password"}
                value={password.value}
                autocomplete="current-password"
                aria-invalid={
                  error.value === "El email o la contraseña no son correctos."
                }
                aria-describedby={error.value ? "login-error" : undefined}
                placeholder="Ingresá tu contraseña"
                onInput$={(_, element) => {
                  password.value = element.value;
                  if (error.value) error.value = "";
                }}
              />
              <button
                type="button"
                aria-controls="login-password"
                aria-label={
                  visible.value ? "Ocultar contraseña" : "Mostrar contraseña"
                }
                aria-pressed={visible.value}
                onClick$={() => (visible.value = !visible.value)}
              >
                {visible.value ? "Ocultar" : "Ver"}
              </button>
            </div>
          </label>
          <button
            class="login-forgot-button"
            type="button"
            disabled={loading.value || recoveryLoading.value}
            onClick$={async () => {
              const normalizedEmail = email.value.trim();
              error.value = "";
              recoveryMessage.value = "";
              if (!normalizedEmail || !normalizedEmail.includes("@")) {
                error.value =
                  "Ingresá tu email para pedir un enlace de recuperación.";
                return;
              }

              recoveryLoading.value = true;
              const { error: recoveryError } =
                await getSupabaseClient().auth.resetPasswordForEmail(
                  normalizedEmail,
                  {
                    redirectTo: passwordResetRedirectUrl(location.url.origin),
                  },
                );
              recoveryLoading.value = false;

              if (recoveryError) {
                error.value =
                  "No pudimos enviar el enlace. Intentá nuevamente más tarde.";
                return;
              }
              recoveryMessage.value = PASSWORD_RECOVERY_SENT_MESSAGE;
            }}
          >
            {recoveryLoading.value
              ? "Enviando enlace…"
              : "¿Olvidaste tu contraseña?"}
          </button>
          {error.value && (
            <p id="login-error" class="login-error" role="alert">
              {error.value}
            </p>
          )}
          {recoveryMessage.value && (
            <p class="login-success" role="status">
              {recoveryMessage.value}
            </p>
          )}
          <button
            class="primary-button login-submit"
            type="submit"
            disabled={loading.value || recoveryLoading.value}
          >
            {loading.value && (
              <span class="button-spinner" aria-hidden="true" />
            )}
            {loading.value ? "Ingresando…" : "Ingresar"}
          </button>
        </form>

        <div class="login-help">
          <Icon name="info" size={16} />
          <span>El acceso es solo para personal autorizado.</span>
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
              <Icon name="check-circle" size={18} /> Mirá los turnos de hoy de
              un vistazo
            </li>
            <li>
              <Icon name="check-circle" size={18} /> Respondé WhatsApp sin
              cambiar de pantalla
            </li>
            <li>
              <Icon name="check-circle" size={18} /> Encontrá cada paciente sin
              complicaciones
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
  title: getPageTitle("Ingresar"),
  meta: [
    { name: "description", content: APP_DESCRIPTION },
    { name: "robots", content: "noindex, nofollow, noarchive" },
  ],
};
