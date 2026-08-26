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
import { getSupabaseClient } from "~/lib/supabase/client";

export default component$(() => {
  const navigate = useNavigate();
  const email = useSignal("");
  const password = useSignal("");
  const visible = useSignal(false);
  const loading = useSignal(false);
  const error = useSignal("");

  useVisibleTask$(async () => {
    const {
      data: { session },
    } = await getSupabaseClient().auth.getSession();
    if (session) await navigate("/app");
  });

  return (
    <main class="login-page">
      <section class="login-panel" aria-labelledby="login-title">
        <div class="login-brand">
          <BusinessLogo />
        </div>

        <div class="login-heading">
          <span class="eyebrow">Acceso al consultorio</span>
          <h1 id="login-title">Hola, {BUSINESS_CONFIG.name.split(" ")[0]}</h1>
          <p>Ingresá con tu email y contraseña para empezar.</p>
        </div>

        <form
          class="login-form"
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

            await navigate("/app");
          }}
        >
          <label>
            <span>Email</span>
            <input
              required
              type="email"
              value={email.value}
              autocomplete="email"
              placeholder="tu@email.com"
              onInput$={(_, element) => (email.value = element.value)}
            />
          </label>
          <label>
            <span>Contraseña</span>
            <div class="password-field">
              <input
                required
                type={visible.value ? "text" : "password"}
                value={password.value}
                autocomplete="current-password"
                placeholder="Ingresá tu contraseña"
                onInput$={(_, element) => (password.value = element.value)}
              />
              <button
                type="button"
                onClick$={() => (visible.value = !visible.value)}
              >
                {visible.value ? "Ocultar" : "Ver"}
              </button>
            </div>
          </label>
          {error.value && (
            <p class="login-error" role="alert">
              {error.value}
            </p>
          )}
          <button
            class="primary-button login-submit"
            type="submit"
            disabled={loading.value}
          >
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
  meta: [{ name: "description", content: APP_DESCRIPTION }],
};
