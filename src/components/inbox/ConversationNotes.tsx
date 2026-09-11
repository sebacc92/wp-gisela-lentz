import {
  $,
  component$,
  useSignal,
  useStore,
  useVisibleTask$,
} from "@qwik.dev/core";
import { formatBusinessDate } from "~/lib/date-time";
import {
  createConversationNote,
  deleteConversationNote,
  loadConversationNotes,
  CONVERSATION_NOTE_MAX_LENGTH,
  type ConversationNote,
} from "~/lib/supabase/conversation-notes";
import { getSupabaseClient } from "~/lib/supabase/client";
import { Icon } from "../ui/Icon";
import "./conversation-notes.css";

interface ConversationNotesProps {
  conversationId: string;
}

function when(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return formatBusinessDate(date, { dateStyle: "short", timeStyle: "short" });
}

/**
 * Notas internas del equipo sobre una conversación.
 *
 * No son historia clínica: eso vive en el odontograma, que es append-only y
 * sólo de ADMIN. Acá va gestión administrativa, y por eso una nota se puede
 * corregir borrándola y escribiendo otra.
 */
export const ConversationNotes = component$<ConversationNotesProps>(
  ({ conversationId }) => {
    const draft = useSignal("");
    const reloadVersion = useSignal(0);
    const state = useStore<{
      notes: ConversationNote[];
      loading: boolean;
      saving: boolean;
      error: string;
    }>({ notes: [], loading: true, saving: false, error: "" });

    // eslint-disable-next-line qwik/no-use-visible-task
    useVisibleTask$(async ({ track }) => {
      track(() => conversationId);
      track(() => reloadVersion.value);
      state.loading = true;
      state.error = "";
      try {
        state.notes = await loadConversationNotes(
          getSupabaseClient(),
          conversationId,
        );
      } catch {
        state.error = "No pudimos cargar las notas internas.";
      } finally {
        state.loading = false;
      }
    });

    const save = $(async () => {
      const body = draft.value.trim();
      if (!body || state.saving) return;
      state.saving = true;
      state.error = "";
      try {
        await createConversationNote(getSupabaseClient(), {
          conversationId,
          body,
        });
        draft.value = "";
        reloadVersion.value += 1;
      } catch {
        state.error = "No pudimos guardar la nota. Intentá de nuevo.";
      } finally {
        state.saving = false;
      }
    });

    return (
      <section
        class="conversation-notes"
        aria-labelledby="conversation-notes-title"
      >
        <header>
          <h3 id="conversation-notes-title">Notas internas</h3>
          <p>
            Sólo las ve el equipo. No se envían por WhatsApp ni las lee el bot.
          </p>
        </header>

        <div class="conversation-notes-composer">
          <label class="sr-only" for="conversation-note-input">
            Escribir una nota interna
          </label>
          <textarea
            id="conversation-note-input"
            rows={2}
            maxLength={CONVERSATION_NOTE_MAX_LENGTH}
            value={draft.value}
            placeholder="Llamó para reprogramar, pidió factura…"
            disabled={state.saving}
            onInput$={(_, element) => (draft.value = element.value)}
            onKeyDown$={async (event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                await save();
              }
            }}
          />
          <button
            class="primary-button small"
            type="button"
            disabled={state.saving || !draft.value.trim()}
            onClick$={save}
          >
            {state.saving ? "Guardando…" : "Agregar nota"}
          </button>
        </div>

        {state.error && (
          <p class="conversation-notes-error" role="alert">
            {state.error}
          </p>
        )}

        {state.loading ? (
          <p class="conversation-notes-empty" role="status">
            <span class="small-spinner" aria-hidden="true" /> Cargando notas…
          </p>
        ) : state.notes.length === 0 ? (
          <p class="conversation-notes-empty">Todavía no hay notas.</p>
        ) : (
          <ul class="conversation-notes-list">
            {state.notes.map((note) => (
              <li key={note.id}>
                <p>{note.body}</p>
                <div class="conversation-notes-meta">
                  <small>
                    {note.authorName ?? "Alguien del equipo"} ·{" "}
                    {when(note.createdAt)}
                  </small>
                  <button
                    type="button"
                    aria-label="Borrar esta nota"
                    onClick$={async () => {
                      if (!window.confirm("¿Borrar esta nota interna?")) return;
                      try {
                        await deleteConversationNote(
                          getSupabaseClient(),
                          note.id,
                        );
                        reloadVersion.value += 1;
                      } catch {
                        state.error =
                          "No pudimos borrar la nota. Sólo puede hacerlo quien la escribió.";
                      }
                    }}
                  >
                    <Icon name="x" size={14} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    );
  },
);
