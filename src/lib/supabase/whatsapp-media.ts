import { getSupabaseClient } from "./client";

/**
 * Descarga un adjunto de WhatsApp a través de la edge function.
 *
 * Los bytes nunca se guardan en la aplicación: se piden con la sesión de quien
 * mira, se convierten en un `blob:` efímero y se revocan al cerrar. Por eso el
 * que llama es responsable de invocar `URL.revokeObjectURL` cuando termina.
 */

export class WhatsAppMediaError extends Error {}

export async function fetchWhatsAppMediaUrl(
  messageId: string,
): Promise<{ url: string; mimeType: string }> {
  const client = getSupabaseClient();
  const { data: sessionData } = await client.auth.getSession();
  const token = sessionData.session?.access_token;
  if (!token) throw new WhatsAppMediaError("UNAUTHORIZED");

  const baseUrl = String(import.meta.env.PUBLIC_SUPABASE_URL ?? "").replace(
    /\/$/,
    "",
  );
  const response = await fetch(
    `${baseUrl}/functions/v1/whatsapp-media?messageId=${encodeURIComponent(messageId)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!response.ok) throw new WhatsAppMediaError("MEDIA_UNAVAILABLE");

  const blob = await response.blob();
  return {
    url: URL.createObjectURL(blob),
    mimeType: blob.type || "application/octet-stream",
  };
}
