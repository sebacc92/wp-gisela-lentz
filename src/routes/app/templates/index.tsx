import {
  component$,
  useSignal,
  useStore,
  useVisibleTask$,
} from "@qwik.dev/core";
import type { DocumentHead } from "@qwik.dev/router";
import { AppNavigation } from "~/components/app/AppNavigation";
import { Icon } from "~/components/ui/Icon";
import { getPageTitle } from "~/config/business";
import { getSupabaseClient } from "~/lib/supabase/client";

interface TemplateRow {
  id: string;
  key: string;
  meta_name: string;
  language_code: string;
  category: string | null;
  body_preview: string;
  enabled: boolean;
  meta_status: string | null;
  meta_template_id: string | null;
  quality_rating: string | null;
  last_synced_at: string | null;
}

interface QuickReplyRow {
  id: string;
  shortcut: string;
  title: string;
  body: string;
  enabled: boolean;
}

export default component$(() => {
  const activeTab = useSignal<"templates" | "quick-replies">("templates");
  const reloadVersion = useSignal(0);
  const notice = useSignal("");
  const state = useStore<{
    templates: TemplateRow[];
    quickReplies: QuickReplyRow[];
    loading: boolean;
    error: string;
  }>({ templates: [], quickReplies: [], loading: true, error: "" });

  useVisibleTask$(async ({ track }) => {
    track(() => reloadVersion.value);
    state.loading = true;
    state.error = "";
    const client = getSupabaseClient();
    const [templatesResult, quickRepliesResult] = await Promise.all([
      client.from("message_templates").select("*").order("key"),
      client.from("quick_replies").select("*").order("shortcut"),
    ]);

    if (templatesResult.error || quickRepliesResult.error) {
      state.error = "No pudimos cargar las plantillas y respuestas.";
    } else {
      state.templates = (templatesResult.data ?? []) as TemplateRow[];
      state.quickReplies = (quickRepliesResult.data ?? []) as QuickReplyRow[];
    }
    state.loading = false;
  });

  return (
    <main class="section-shell">
      <AppNavigation active="templates" />
      <section class="section-page">
        <header class="section-page-header">
          <div>
            <span class="eyebrow">WhatsApp</span>
            <h1>Plantillas y respuestas</h1>
            <p>Mensajes frecuentes para responder más rápido.</p>
          </div>
        </header>
        <div class="simple-tabs">
          <button
            class={{ active: activeTab.value === "templates" }}
            type="button"
            onClick$={() => (activeTab.value = "templates")}
          >
            Plantillas
          </button>
          <button
            class={{ active: activeTab.value === "quick-replies" }}
            type="button"
            onClick$={() => (activeTab.value = "quick-replies")}
          >
            Respuestas rápidas
          </button>
        </div>

        {state.loading ? (
          <div class="section-empty">
            <span class="small-spinner" />
            <p>Cargando mensajes…</p>
          </div>
        ) : state.error ? (
          <div class="section-empty">
            <Icon name="info" size={22} />
            <p>{state.error}</p>
          </div>
        ) : activeTab.value === "templates" ? (
          <div class="template-list">
            {state.templates.map((template) => (
              <button
                class="template-item"
                type="button"
                key={template.id}
                onClick$={async () => {
                  const safeToEnable =
                    template.meta_status?.toUpperCase() === "APPROVED" &&
                    template.category?.toUpperCase() === "UTILITY" &&
                    template.quality_rating?.toUpperCase() !== "RED";
                  if (!template.enabled && !safeToEnable) {
                    notice.value =
                      "Meta debe aprobar la plantilla como Utility y su calidad no puede ser roja.";
                    return;
                  }
                  const { error } = await getSupabaseClient()
                    .from("message_templates")
                    .update({ enabled: !template.enabled })
                    .eq("id", template.id);
                  if (error) {
                    notice.value =
                      "Solo un administrador puede cambiar las plantillas.";
                    return;
                  }
                  template.enabled = !template.enabled;
                }}
              >
                <span class="template-icon">
                  <Icon name="file" size={18} />
                </span>
                <span class="template-copy">
                  <strong>{template.meta_name}</strong>
                  <small>
                    {template.body_preview} · {template.language_code} ·{" "}
                    {template.category || "Sin categoría"}
                  </small>
                  <small class="template-sync-copy">
                    {template.last_synced_at
                      ? `Sincronizada ${new Intl.DateTimeFormat("es-AR", {
                          dateStyle: "short",
                          timeStyle: "short",
                        }).format(new Date(template.last_synced_at))}`
                      : "Todavía no sincronizada con Meta"}
                    {template.quality_rating
                      ? ` · Calidad ${template.quality_rating}`
                      : ""}
                  </small>
                </span>
                <span class="template-states">
                  <span
                    class={{
                      "integration-state": true,
                      off: !template.enabled,
                    }}
                  >
                    <i />
                    {template.enabled
                      ? "Habilitada localmente"
                      : "Deshabilitada localmente"}
                  </span>
                  <span
                    class={{
                      "integration-state": true,
                      off: template.meta_status?.toUpperCase() !== "APPROVED",
                    }}
                  >
                    <i /> Meta: {template.meta_status || "sin verificar"}
                  </span>
                </span>
                <Icon name="more" size={19} />
              </button>
            ))}
          </div>
        ) : (
          <div class="template-list">
            {state.quickReplies.map((reply) => (
              <button
                class="template-item"
                type="button"
                key={reply.id}
                onClick$={async () => {
                  const { error } = await getSupabaseClient()
                    .from("quick_replies")
                    .update({ enabled: !reply.enabled })
                    .eq("id", reply.id);
                  if (error) {
                    notice.value =
                      "Solo un administrador puede cambiar las respuestas.";
                    return;
                  }
                  reply.enabled = !reply.enabled;
                }}
              >
                <span class="template-icon">
                  <Icon name="message" size={18} />
                </span>
                <span class="template-copy">
                  <strong>
                    {reply.shortcut} · {reply.title}
                  </strong>
                  <small>{reply.body}</small>
                </span>
                <span
                  class={{ "integration-state": true, off: !reply.enabled }}
                >
                  <i /> {reply.enabled ? "Activa" : "Inactiva"}
                </span>
                <Icon name="more" size={19} />
              </button>
            ))}
          </div>
        )}
      </section>

      {notice.value && (
        <div class="toast" role="status">
          <span>{notice.value}</span>
          <button type="button" onClick$={() => (notice.value = "")}>
            ×
          </button>
        </div>
      )}
    </main>
  );
});

export const head: DocumentHead = { title: getPageTitle("Plantillas") };
