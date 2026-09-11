import {
  component$,
  useContext,
  useSignal,
  useStore,
  useVisibleTask$,
} from "@qwik.dev/core";
import type { DocumentHead } from "@qwik.dev/router";
import { AppNavigation } from "~/components/app/AppNavigation";
import { APP_USER_CONTEXT } from "~/components/app/AppUserContext";
import { Icon } from "~/components/ui/Icon";
import { getPageTitle } from "~/config/business";
import { getSupabaseClient } from "~/lib/supabase/client";
import {
  renderTemplatePreview,
  reviewTemplateContent,
  templateParameters,
} from "~/lib/whatsapp-template-preview";
import "./templates.css";

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
  const appUser = useContext(APP_USER_CONTEXT);
  const activeTab = useSignal<"templates" | "quick-replies">("templates");
  const reloadVersion = useSignal(0);
  const notice = useSignal("");
  const previewId = useSignal("");
  const syncing = useSignal(false);
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
      <section id="app-content" class="section-page" tabIndex={-1}>
        <header class="section-page-header">
          <div>
            <span class="eyebrow">WhatsApp</span>
            <h1>Plantillas y respuestas</h1>
            <p>Mensajes frecuentes para responder más rápido.</p>
          </div>
          {appUser.isAdmin && (
            <button
              class="secondary-button"
              type="button"
              disabled={syncing.value}
              onClick$={async () => {
                if (syncing.value) return;
                syncing.value = true;
                notice.value = "";
                try {
                  // `whatsapp-health` ya consulta Meta y guarda el estado de
                  // cada plantilla; acá sólo se dispara y se relee la tabla.
                  const { data, error } =
                    await getSupabaseClient().functions.invoke(
                      "whatsapp-health",
                      { method: "POST" },
                    );
                  if (error) throw error;
                  reloadVersion.value += 1;
                  notice.value =
                    data?.status === "incomplete"
                      ? "La conexión con WhatsApp todavía no está configurada."
                      : "Estados actualizados desde Meta.";
                } catch {
                  notice.value =
                    "No pudimos consultar a Meta. Los estados quedaron como estaban.";
                } finally {
                  syncing.value = false;
                }
              }}
            >
              <Icon name="spark" size={17} />
              {syncing.value ? "Consultando a Meta…" : "Sincronizar con Meta"}
            </button>
          )}
        </header>
        <div class="simple-tabs" role="tablist" aria-label="Tipo de mensaje">
          <button
            id="templates-tab"
            class={{ active: activeTab.value === "templates" }}
            type="button"
            role="tab"
            aria-selected={activeTab.value === "templates"}
            aria-controls={
              !state.loading && !state.error ? "templates-panel" : undefined
            }
            tabIndex={activeTab.value === "templates" ? 0 : -1}
            onClick$={() => (activeTab.value = "templates")}
            onKeyDown$={(event) => {
              if (
                !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
              )
                return;
              event.preventDefault();
              const next =
                event.key === "ArrowRight" || event.key === "End"
                  ? "quick-replies"
                  : "templates";
              activeTab.value = next;
              requestAnimationFrame(() =>
                document.getElementById(`${next}-tab`)?.focus(),
              );
            }}
          >
            Plantillas
          </button>
          <button
            id="quick-replies-tab"
            class={{ active: activeTab.value === "quick-replies" }}
            type="button"
            role="tab"
            aria-selected={activeTab.value === "quick-replies"}
            aria-controls={
              !state.loading && !state.error ? "quick-replies-panel" : undefined
            }
            tabIndex={activeTab.value === "quick-replies" ? 0 : -1}
            onClick$={() => (activeTab.value = "quick-replies")}
            onKeyDown$={(event) => {
              if (
                !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
              )
                return;
              event.preventDefault();
              const next =
                event.key === "ArrowLeft" || event.key === "Home"
                  ? "templates"
                  : "quick-replies";
              activeTab.value = next;
              requestAnimationFrame(() =>
                document.getElementById(`${next}-tab`)?.focus(),
              );
            }}
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
          <div
            id="templates-panel"
            class="template-list"
            role="tabpanel"
            aria-labelledby="templates-tab"
            tabIndex={0}
          >
            {state.templates.map((template) => {
              const issues = reviewTemplateContent(template.body_preview);
              const parameters = templateParameters(template.body_preview);
              const open = previewId.value === template.id;
              return (
                <article class="template-item" key={template.id}>
                  <div class="template-item-main">
                    <span class="template-icon">
                      <Icon name="file" size={18} />
                    </span>
                    <span class="template-copy">
                      <strong>{template.meta_name}</strong>
                      <small>
                        {template.language_code} ·{" "}
                        {template.category || "Sin categoría"}
                        {parameters.length > 0
                          ? ` · ${parameters.length} parámetro${parameters.length === 1 ? "" : "s"}`
                          : ""}
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
                          off:
                            template.meta_status?.toUpperCase() !== "APPROVED",
                        }}
                      >
                        <i /> Meta: {template.meta_status || "sin verificar"}
                      </span>
                    </span>
                  </div>

                  {issues.length > 0 && (
                    <ul class="template-issues">
                      {issues.map((issue) => (
                        <li key={issue.message} class={issue.level}>
                          <Icon
                            name={issue.level === "blocker" ? "alert" : "info"}
                            size={14}
                          />
                          {issue.message}
                        </li>
                      ))}
                    </ul>
                  )}

                  {open && (
                    <div class="template-preview">
                      <span class="template-preview-label">
                        Así le llega al paciente
                      </span>
                      <div class="whatsapp-bubble">
                        <p>{renderTemplatePreview(template.body_preview)}</p>
                        <span class="whatsapp-bubble-meta">
                          10:30
                          <Icon name="check" size={12} />
                          <Icon name="check" size={12} />
                        </span>
                      </div>
                      <small class="template-preview-note">
                        Los datos son de ejemplo. Meta reemplaza {"{{1}}"},{" "}
                        {"{{2}}"}… al enviar.
                      </small>
                    </div>
                  )}

                  <div class="template-actions">
                    <button
                      class="secondary-button small"
                      type="button"
                      aria-expanded={open}
                      onClick$={() =>
                        (previewId.value = open ? "" : template.id)
                      }
                    >
                      {open ? "Ocultar vista previa" : "Ver vista previa"}
                    </button>
                    <button
                      class="secondary-button small"
                      type="button"
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
                      {template.enabled ? "Deshabilitar" : "Habilitar"}
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div
            id="quick-replies-panel"
            class="template-list"
            role="tabpanel"
            aria-labelledby="quick-replies-tab"
            tabIndex={0}
          >
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
