import {
  component$,
  Slot,
  useContextProvider,
  useSignal,
  useStore,
  useVisibleTask$,
} from "@qwik.dev/core";
import type { DocumentHead } from "@qwik.dev/router";
import { useLocation, useNavigate } from "@qwik.dev/router";
import {
  APP_USER_CONTEXT,
  type AppUserContextValue,
} from "~/components/app/AppUserContext";
import { GlobalSearch } from "~/components/app/GlobalSearch";
import { InboxNotifications } from "~/components/app/InboxNotifications";
import {
  BOT_AUTOMATION_CONTEXT,
  type BotAutomationContextValue,
} from "~/components/app/BotAutomationContext";
import { BUSINESS_CONFIG } from "~/config/business";
import { isAdminProfile } from "~/lib/admin-access";
import { getSupabaseClient } from "~/lib/supabase/client";

export default component$(() => {
  const navigate = useNavigate();
  const location = useLocation();
  const ready = useSignal(false);
  const error = useSignal("");
  const appUser = useStore<AppUserContextValue>({
    fullName: BUSINESS_CONFIG.name,
    isAdmin: false,
    preserveInboxUnread: false,
  });
  const botAutomation = useStore<BotAutomationContextValue>({
    enabled: null,
    saving: false,
    error: "",
  });
  useContextProvider(APP_USER_CONTEXT, appUser);
  useContextProvider(BOT_AUTOMATION_CONTEXT, botAutomation);
  const requestedPath = `${location.url.pathname}${location.url.search}${location.url.hash}`;
  const loginUrl = `/login?next=${encodeURIComponent(requestedPath)}`;
  const inactiveLoginUrl = `${loginUrl}&error=inactive`;

  useVisibleTask$(async () => {
    try {
      const client = getSupabaseClient();
      const {
        data: { session },
      } = await client.auth.getSession();

      if (!session) {
        await navigate(loginUrl);
        return;
      }

      const [profileResult, automationResult] = await Promise.all([
        client
          .from("profiles")
          .select("full_name,role,active,preserve_inbox_unread")
          .eq("id", session.user.id)
          .single(),
        client
          .from("app_settings")
          .select("automations_enabled")
          .eq("id", true)
          .single(),
      ]);
      const { data: profile, error: profileError } = profileResult;

      // Un fallo consultando el perfil no demuestra que el acceso se haya
      // revocado: mantenemos el panel cerrado, pero conservamos la sesión.
      if (profileError) throw profileError;

      if (!profile?.active) {
        await client.auth.signOut();
        await navigate(inactiveLoginUrl);
        return;
      }

      appUser.fullName = profile.full_name?.trim() || BUSINESS_CONFIG.name;
      appUser.isAdmin = isAdminProfile(profile);
      appUser.preserveInboxUnread = profile.preserve_inbox_unread === true;
      if (
        automationResult.error ||
        typeof automationResult.data?.automations_enabled !== "boolean"
      ) {
        botAutomation.error =
          "No pudimos consultar el bot. Revisá la conexión e intentá de nuevo.";
      } else {
        botAutomation.enabled = automationResult.data.automations_enabled;
      }
      ready.value = true;
    } catch {
      error.value =
        "No pudimos validar tu sesión. Revisá la conexión e intentá nuevamente.";
    }
  });

  if (error.value) {
    return (
      <main class="auth-loading">
        <strong>No pudimos abrir la plataforma</strong>
        <p>{error.value}</p>
        <button type="button" onClick$={() => window.location.reload()}>
          Reintentar
        </button>
        <button type="button" onClick$={() => navigate(loginUrl)}>
          Volver a ingresar
        </button>
      </main>
    );
  }

  if (!ready.value) {
    return (
      <main class="auth-loading" aria-live="polite">
        <span class="small-spinner" aria-hidden="true" />
        <p>Validando acceso…</p>
      </main>
    );
  }

  // Ambos son globales del panel y viven acá para estar en todas las
  // pantallas sin que cada ruta los repita.
  return (
    <>
      <Slot />
      <GlobalSearch />
      <InboxNotifications />
    </>
  );
});

export const head: DocumentHead = {
  meta: [{ name: "robots", content: "noindex, nofollow, noarchive" }],
};
