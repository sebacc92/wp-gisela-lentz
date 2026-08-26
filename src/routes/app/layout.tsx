import { component$, Slot, useSignal, useVisibleTask$ } from "@qwik.dev/core";
import { useNavigate } from "@qwik.dev/router";
import { getSupabaseClient } from "~/lib/supabase/client";

export default component$(() => {
  const navigate = useNavigate();
  const ready = useSignal(false);
  const error = useSignal("");

  useVisibleTask$(async () => {
    try {
      const client = getSupabaseClient();
      const {
        data: { session },
      } = await client.auth.getSession();

      if (!session) {
        await navigate("/login");
        return;
      }

      const { data: profile, error: profileError } = await client
        .from("profiles")
        .select("active")
        .eq("id", session.user.id)
        .single();

      if (profileError || !profile?.active) {
        await client.auth.signOut();
        await navigate("/login?error=inactive");
        return;
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
        <button type="button" onClick$={() => navigate("/login")}>
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

  return <Slot />;
});
