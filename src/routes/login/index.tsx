import { $, component$, useSignal, useVisibleTask$ } from "@qwik.dev/core";
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
import { getSupabaseClient, isSupabaseConfigured } from "~/lib/supabase/client";
import {
  captchaOptions,
  isCaptchaError,
  loadTurnstile,
  TURNSTILE_ACTION,
  TURNSTILE_FAILED_MESSAGE,
  TURNSTILE_PENDING_MESSAGE,
  turnstileSitekey,
} from "~/lib/turnstile";

/** Sin sitekey configurado no hay widget ni token: el login sigue funcionando
 * igual que antes. Es lo que mantiene vivo el desarrollo local mientras el
 * CAPTCHA de Supabase todavía no está encendido. */
const CAPTCHA_SITEKEY = turnstileSitekey(
  import.meta.env.PUBLIC_TURNSTILE_SITEKEY,
);
const CONFIGURATION_ERROR_MESSAGE =
  "El acceso no está disponible por un problema de configuración. Intentá nuevamente más tarde.";

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
  const configured = isSupabaseConfigured();
  const error = useSignal(configured ? "" : CONFIGURATION_ERROR_MESSAGE);
  const destination = safeLoginDestination(
    location.url.searchParams.get("next"),
    location.url,
  );
  const captchaToken = useSignal("");
  const captchaWidget = useSignal("");
  const captchaSlot = useSignal<HTMLDivElement>();

  useVisibleTask$(async ({ cleanup }) => {
    if (!CAPTCHA_SITEKEY || !captchaSlot.value) return;
    try {
      await loadTurnstile();
    } catch {
      error.value = TURNSTILE_FAILED_MESSAGE;
      return;
    }
    const widgetId = window.turnstile?.render(captchaSlot.value, {
      sitekey: CAPTCHA_SITEKEY,
      action: TURNSTILE_ACTION,
      callback: (token: string) => {
        captchaToken.value = token;
      },
      "expired-callback": () => {
        captchaToken.value = "";
      },
      "error-callback": () => {
        captchaToken.value = "";
      },
    });
    captchaWidget.value = widgetId ?? "";
    cleanup(() => {
      if (widgetId) window.turnstile?.remove(widgetId);
    });
  });

  // El token se gasta en cada intento. Sin reset, el segundo envío viaja con
  // uno ya redimido y Supabase lo rechaza como si fuera un bot.
  const resetCaptcha = $(() => {
    captchaToken.value = "";
    try {
      if (captchaWidget.value) window.turnstile?.reset(captchaWidget.value);
    } catch {
      if (!error.value) error.value = TURNSTILE_FAILED_MESSAGE;
    }
  });

  useVisibleTask$(async () => {
    if (!configured) {
      error.value = CONFIGURATION_ERROR_MESSAGE;
      return;
    }
    if (location.url.searchParams.get("error") === "inactive") {
      error.value =
        "Tu acceso está inactivo. Consultá con la persona administradora.";
    }
    try {
      const {
        data: { session },
        error: sessionError,
      } = await getSupabaseClient().auth.getSession();
      if (sessionError) {
        error.value =
          "No pudimos validar tu sesión. Revisá la conexión e intentá nuevamente.";
        return;
      }
      if (session) await navigate(destination);
    } catch {
      error.value =
        "No pudimos validar tu sesión. Revisá la conexión e intentá nuevamente.";
    }
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
            if (!configured) {
              error.value = CONFIGURATION_ERROR_MESSAGE;
              return;
            }
            if (loading.value || recoveryLoading.value) return;
            if (CAPTCHA_SITEKEY && !captchaToken.value) {
              error.value = TURNSTILE_PENDING_MESSAGE;
              return;
            }
            loading.value = true;
            error.value = "";
            try {
              const { error: signInError } =
                await getSupabaseClient().auth.signInWithPassword({
                  email: email.value.trim(),
                  password: password.value,
                  options: captchaOptions(captchaToken.value),
                });

              if (signInError) {
                error.value = isCaptchaError(signInError.message)
                  ? TURNSTILE_FAILED_MESSAGE
                  : signInError.message === "Invalid login credentials"
                    ? "El email o la contraseña no son correctos."
                    : "No pudimos iniciar sesión. Intentá nuevamente.";
                return;
              }
            } catch {
              error.value =
                "No pudimos iniciar sesión. Revisá la conexión e intentá nuevamente.";
              return;
            } finally {
              loading.value = false;
              await resetCaptcha();
            }

            try {
              await navigate(destination);
            } catch {
              error.value =
                "Iniciaste sesión, pero no pudimos abrir el panel. Recargá la página para continuar.";
            }
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
            disabled={!configured || loading.value || recoveryLoading.value}
            onClick$={async () => {
              if (!configured) {
                error.value = CONFIGURATION_ERROR_MESSAGE;
                return;
              }
              if (loading.value || recoveryLoading.value) return;
              const normalizedEmail = email.value.trim();
              error.value = "";
              recoveryMessage.value = "";
              if (!normalizedEmail || !normalizedEmail.includes("@")) {
                error.value =
                  "Ingresá tu email para pedir un enlace de recuperación.";
                return;
              }

              if (CAPTCHA_SITEKEY && !captchaToken.value) {
                error.value = TURNSTILE_PENDING_MESSAGE;
                return;
              }

              recoveryLoading.value = true;
              try {
                const { error: recoveryError } =
                  await getSupabaseClient().auth.resetPasswordForEmail(
                    normalizedEmail,
                    {
                      redirectTo: passwordResetRedirectUrl(location.url.origin),
                      ...captchaOptions(captchaToken.value),
                    },
                  );

                if (recoveryError) {
                  error.value = isCaptchaError(recoveryError.message)
                    ? TURNSTILE_FAILED_MESSAGE
                    : "No pudimos enviar el enlace. Intentá nuevamente más tarde.";
                  return;
                }
                recoveryMessage.value = PASSWORD_RECOVERY_SENT_MESSAGE;
              } catch {
                error.value =
                  "No pudimos enviar el enlace. Revisá la conexión e intentá nuevamente.";
              } finally {
                recoveryLoading.value = false;
                await resetCaptcha();
              }
            }}
          >
            {recoveryLoading.value
              ? "Enviando enlace…"
              : "¿Olvidaste tu contraseña?"}
          </button>
          {CAPTCHA_SITEKEY && (
            <div
              class="login-captcha"
              ref={captchaSlot}
              aria-label="Verificación de seguridad"
            />
          )}
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
            disabled={!configured || loading.value || recoveryLoading.value}
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
