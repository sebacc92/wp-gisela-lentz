import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Adjuntos clínicos de un paciente (radiografías, estudios, documentos).
 *
 * Los bytes viven en un bucket privado; esta tabla es sólo el índice. Nada se
 * sirve por URL pública: cada apertura pide una URL firmada de corta duración
 * con la sesión de quien mira, y RLS exige ADMIN en la tabla y en el bucket.
 */

export const ATTACHMENT_BUCKET = "patient-attachments";
export const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;
export const ATTACHMENT_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "application/pdf",
] as const;

/** La URL firmada dura lo que una consulta, no lo que una sesión. */
const SIGNED_URL_SECONDS = 120;

export interface PatientAttachment {
  id: string;
  contactId: string;
  storagePath: string;
  filename: string;
  mimeType: string;
  byteSize: number;
  description: string | null;
  uploadedByName: string | null;
  createdAt: string;
}

function relation<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

export async function loadPatientAttachments(
  client: SupabaseClient,
  contactId: string,
): Promise<PatientAttachment[]> {
  const { data, error } = await client
    .from("patient_attachments")
    .select(
      "id,contact_id,storage_path,filename,mime_type,byte_size,description,created_at,profiles(full_name)",
    )
    .eq("contact_id", contactId)
    .order("created_at", { ascending: false });
  if (error) throw error;

  return (data ?? []).map((raw) => {
    const row = raw as unknown as {
      id: string;
      contact_id: string;
      storage_path: string;
      filename: string;
      mime_type: string;
      byte_size: number;
      description: string | null;
      created_at: string;
      profiles: { full_name: string } | Array<{ full_name: string }> | null;
    };
    return {
      id: row.id,
      contactId: row.contact_id,
      storagePath: row.storage_path,
      filename: row.filename,
      mimeType: row.mime_type,
      byteSize: Number(row.byte_size),
      description: row.description,
      uploadedByName: relation(row.profiles)?.full_name ?? null,
      createdAt: row.created_at,
    };
  });
}

/** Nombre seguro para Storage: sin rutas ni caracteres que rompan la clave. */
export function storageSafeName(filename: string): string {
  return (
    filename
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 100) || "archivo"
  );
}

export async function uploadPatientAttachment(
  client: SupabaseClient,
  input: { contactId: string; file: File; description?: string },
): Promise<void> {
  const { data: userData } = await client.auth.getUser();
  const uploadedBy = userData.user?.id;
  // La política exige que quien sube quede registrado.
  if (!uploadedBy) throw new Error("UNAUTHORIZED");

  const path = `${input.contactId}/${crypto.randomUUID()}-${storageSafeName(input.file.name)}`;
  const upload = await client.storage
    .from(ATTACHMENT_BUCKET)
    .upload(path, input.file, {
      contentType: input.file.type,
      upsert: false,
    });
  if (upload.error) throw upload.error;

  const { error } = await client.from("patient_attachments").insert({
    contact_id: input.contactId,
    storage_path: path,
    filename: input.file.name.slice(0, 200),
    mime_type: input.file.type,
    byte_size: input.file.size,
    description: input.description?.trim() || null,
    uploaded_by: uploadedBy,
  });

  if (error) {
    // El índice manda: un archivo sin fila es basura invisible en el bucket.
    await client.storage.from(ATTACHMENT_BUCKET).remove([path]);
    throw error;
  }
}

export async function signedAttachmentUrl(
  client: SupabaseClient,
  storagePath: string,
): Promise<string> {
  const { data, error } = await client.storage
    .from(ATTACHMENT_BUCKET)
    .createSignedUrl(storagePath, SIGNED_URL_SECONDS);
  if (error || !data?.signedUrl) throw error ?? new Error("SIGN_FAILED");
  return data.signedUrl;
}

export async function deletePatientAttachment(
  client: SupabaseClient,
  attachment: { id: string; storagePath: string },
): Promise<void> {
  const { error } = await client
    .from("patient_attachments")
    .delete()
    .eq("id", attachment.id);
  if (error) throw error;
  // Si el borrado del objeto falla, la fila ya no está y el archivo queda
  // huérfano en el bucket; se prefiere eso a mostrar un adjunto sin permiso.
  await client.storage.from(ATTACHMENT_BUCKET).remove([attachment.storagePath]);
}
