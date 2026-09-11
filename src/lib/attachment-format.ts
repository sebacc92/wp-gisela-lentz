/** Presentación de adjuntos: tamaño legible y validación previa a subir. */

export const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;
const ALLOWED = new Set(["image/jpeg", "image/png", "application/pdf"]);

export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 KB";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Revisión antes de subir. La base y el bucket vuelven a validar lo mismo;
 * esto sólo evita una subida que va a fallar y explica por qué.
 */
export function attachmentRejection(file: {
  type: string;
  size: number;
}): string | null {
  if (!ALLOWED.has(file.type)) {
    return "Sólo se aceptan imágenes JPG o PNG y archivos PDF.";
  }
  if (file.size <= 0) return "El archivo está vacío.";
  if (file.size > ATTACHMENT_MAX_BYTES) {
    return `El archivo supera los ${formatBytes(ATTACHMENT_MAX_BYTES)} permitidos.`;
  }
  return null;
}
