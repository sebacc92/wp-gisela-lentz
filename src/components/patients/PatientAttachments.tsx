import {
  $,
  component$,
  useSignal,
  useStore,
  useVisibleTask$,
} from "@qwik.dev/core";
import { Icon } from "~/components/ui/Icon";
import { attachmentRejection, formatBytes } from "~/lib/attachment-format";
import { formatBusinessDate } from "~/lib/date-time";
import { getSupabaseClient } from "~/lib/supabase/client";
import {
  deletePatientAttachment,
  loadPatientAttachments,
  signedAttachmentUrl,
  uploadPatientAttachment,
  type PatientAttachment,
} from "~/lib/supabase/patient-attachments";
import "./patient-attachments.css";

interface Props {
  contactId: string;
  isAdmin: boolean;
}

/**
 * Radiografías y documentos de un paciente.
 *
 * Es información de salud, así que sigue la misma regla que el odontograma:
 * sólo ADMIN. El bucket es privado y cada apertura pide una URL firmada de dos
 * minutos, en lugar de dejar un enlace permanente dando vueltas.
 */
export const PatientAttachments = component$<Props>(
  ({ contactId, isAdmin }) => {
    const reloadVersion = useSignal(0);
    const description = useSignal("");
    const state = useStore<{
      items: PatientAttachment[];
      loading: boolean;
      uploading: boolean;
      error: string;
    }>({ items: [], loading: true, uploading: false, error: "" });

    // eslint-disable-next-line qwik/no-use-visible-task
    useVisibleTask$(async ({ track }) => {
      track(() => contactId);
      track(() => reloadVersion.value);
      if (!isAdmin) {
        state.loading = false;
        return;
      }
      state.loading = true;
      state.error = "";
      try {
        state.items = await loadPatientAttachments(
          getSupabaseClient(),
          contactId,
        );
      } catch {
        state.error = "No pudimos cargar los adjuntos.";
      } finally {
        state.loading = false;
      }
    });

    const open = $(async (attachment: PatientAttachment) => {
      try {
        const url = await signedAttachmentUrl(
          getSupabaseClient(),
          attachment.storagePath,
        );
        window.open(url, "_blank", "noopener,noreferrer");
      } catch {
        state.error = "No pudimos abrir el archivo. Intentá de nuevo.";
      }
    });

    if (!isAdmin) {
      return (
        <p class="patient-attachments-empty">
          Los estudios y documentos del paciente sólo los ve una persona
          administradora.
        </p>
      );
    }

    return (
      <div class="patient-attachments">
        <label class="patient-attachments-upload">
          <input
            type="file"
            accept="image/jpeg,image/png,application/pdf"
            disabled={state.uploading}
            onChange$={async (_, element) => {
              const file = element.files?.[0];
              if (!file) return;
              const rejection = attachmentRejection(file);
              if (rejection) {
                state.error = rejection;
                element.value = "";
                return;
              }
              state.uploading = true;
              state.error = "";
              try {
                await uploadPatientAttachment(getSupabaseClient(), {
                  contactId,
                  file,
                  description: description.value,
                });
                description.value = "";
                reloadVersion.value += 1;
              } catch {
                state.error =
                  "No pudimos guardar el archivo. Revisá el formato y el tamaño.";
              } finally {
                state.uploading = false;
                element.value = "";
              }
            }}
          />
          <span class="secondary-button">
            <Icon name="paperclip" size={16} />
            {state.uploading ? "Subiendo…" : "Agregar archivo"}
          </span>
        </label>

        <label class="form-field">
          <span>Descripción (opcional)</span>
          <input
            type="text"
            maxLength={500}
            value={description.value}
            placeholder="Radiografía panorámica, presupuesto…"
            onInput$={(_, element) => (description.value = element.value)}
          />
        </label>

        <p class="patient-attachments-note">
          JPG, PNG o PDF, hasta 20 MB. Se guardan en un espacio privado y se
          abren con un enlace temporal.
        </p>

        {state.error && (
          <p class="patient-attachments-error" role="alert">
            {state.error}
          </p>
        )}

        {state.loading ? (
          <p class="patient-attachments-empty" role="status">
            <span class="small-spinner" aria-hidden="true" /> Cargando adjuntos…
          </p>
        ) : state.items.length === 0 ? (
          <p class="patient-attachments-empty">Todavía no hay archivos.</p>
        ) : (
          <ul class="patient-attachments-list">
            {state.items.map((attachment) => (
              <li key={attachment.id}>
                <span class="patient-attachment-icon" aria-hidden="true">
                  <Icon
                    name={
                      attachment.mimeType === "application/pdf"
                        ? "file"
                        : "smile"
                    }
                    size={16}
                  />
                </span>
                <span class="patient-attachment-copy">
                  <strong>{attachment.filename}</strong>
                  <small>
                    {formatBytes(attachment.byteSize)} ·{" "}
                    {formatBusinessDate(new Date(attachment.createdAt), {
                      dateStyle: "short",
                    })}
                    {attachment.uploadedByName
                      ? ` · ${attachment.uploadedByName}`
                      : ""}
                  </small>
                  {attachment.description && (
                    <small>{attachment.description}</small>
                  )}
                </span>
                <span class="patient-attachment-actions">
                  <button
                    class="secondary-button small"
                    type="button"
                    onClick$={() => open(attachment)}
                  >
                    Abrir
                  </button>
                  <button
                    class="patient-attachment-delete"
                    type="button"
                    aria-label={`Borrar ${attachment.filename}`}
                    onClick$={async () => {
                      if (
                        !window.confirm(
                          `¿Borrar "${attachment.filename}"? No se puede deshacer.`,
                        )
                      ) {
                        return;
                      }
                      try {
                        await deletePatientAttachment(getSupabaseClient(), {
                          id: attachment.id,
                          storagePath: attachment.storagePath,
                        });
                        reloadVersion.value += 1;
                      } catch {
                        state.error = "No pudimos borrar el archivo.";
                      }
                    }}
                  >
                    <Icon name="x" size={15} />
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  },
);
