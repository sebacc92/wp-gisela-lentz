/**
 * Cómo mostrar un adjunto.
 *
 * Se decide por el tipo declarado del mensaje y, si hace falta, por el MIME
 * real que devolvió la descarga. Ante la duda no se adivina: un adjunto
 * desconocido se ofrece para descargar en lugar de incrustarlo.
 */

export type MediaKind = "image" | "pdf" | "audio" | "other";

export function mediaKind(input: {
  messageType?: string | null;
  mimeType?: string | null;
}): MediaKind {
  const mime = input.mimeType?.toLowerCase() ?? "";
  if (mime.startsWith("image/")) return "image";
  if (mime === "application/pdf") return "pdf";
  if (mime.startsWith("audio/")) return "audio";

  // Sin MIME confiable, el tipo del mensaje alcanza para imagen y audio.
  if (!mime || mime === "application/octet-stream") {
    if (input.messageType === "image") return "image";
    if (input.messageType === "audio") return "audio";
  }
  return "other";
}

export function mediaKindLabel(kind: MediaKind): string {
  if (kind === "image") return "Imagen";
  if (kind === "pdf") return "Documento PDF";
  if (kind === "audio") return "Nota de voz";
  return "Archivo";
}
