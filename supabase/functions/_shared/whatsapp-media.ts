export const DEFAULT_WHATSAPP_MEDIA_MAX_BYTES = 10 * 1024 * 1024;
export const MAX_WHATSAPP_MEDIA_MAX_BYTES = 20 * 1024 * 1024;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MEDIA_ID_PATTERN = /^[0-9]{5,64}$/;
const ALLOWED_DOWNLOAD_HOSTS = new Set(["lookaside.fbsbx.com"]);
const TYPE_MIME_ALLOWLIST = {
  image: new Set(["image/jpeg", "image/png"]),
  document: new Set(["application/pdf"]),
} as const;

export type DownloadableWhatsAppMediaType = keyof typeof TYPE_MIME_ALLOWLIST;

export interface WhatsAppMediaDescriptor {
  type: DownloadableWhatsAppMediaType;
  mediaId: string;
  mimeType: string;
  filename: string;
  disposition: "inline";
}

export class WhatsAppMediaValidationError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "WhatsAppMediaValidationError";
    this.code = code;
  }
}

function normalizedMimeType(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(
    normalized,
  )
    ? normalized
    : null;
}

export function isValidMessageUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export function isValidWhatsAppMediaId(value: unknown): value is string {
  return typeof value === "string" && MEDIA_ID_PATTERN.test(value);
}

export function whatsappMediaMaxBytes(value: string | undefined): number {
  if (!value?.trim()) return DEFAULT_WHATSAPP_MEDIA_MAX_BYTES;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) &&
    parsed >= 1024 &&
    parsed <= MAX_WHATSAPP_MEDIA_MAX_BYTES
    ? parsed
    : DEFAULT_WHATSAPP_MEDIA_MAX_BYTES;
}

export function isAllowedWhatsAppMediaDownloadUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      ALLOWED_DOWNLOAD_HOSTS.has(url.hostname.toLowerCase())
    );
  } catch {
    return false;
  }
}

function extensionForMimeType(mimeType: string): string {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/png") return "png";
  return "pdf";
}

export function safeWhatsAppMediaFilename(
  value: unknown,
  mimeType: string,
): string {
  const extension = extensionForMimeType(mimeType);
  if (typeof value !== "string") return `comprobante.${extension}`;
  const cleaned = value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/]/g, "-")
    .replace(/[^\p{L}\p{N} ._()-]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
  if (!cleaned) return `comprobante.${extension}`;
  const withoutExtension = cleaned.replace(/\.[A-Za-z0-9]{1,8}$/, "").trim();
  const safeBase = withoutExtension.replace(/^[.\s-]+/, "").trim();
  return `${safeBase || "comprobante"}.${extension}`;
}

export function resolveWhatsAppMediaDescriptor(args: {
  messageDirection: unknown;
  messageType: unknown;
  metadata: unknown;
  graphMediaId: unknown;
  graphMimeType: unknown;
  graphFileSize: unknown;
  maxBytes: number;
}): WhatsAppMediaDescriptor {
  if (args.messageDirection !== "inbound") {
    throw new WhatsAppMediaValidationError("MEDIA_NOT_INBOUND");
  }
  if (args.messageType !== "image" && args.messageType !== "document") {
    throw new WhatsAppMediaValidationError("MEDIA_TYPE_NOT_ALLOWED");
  }
  const metadata =
    args.metadata &&
    typeof args.metadata === "object" &&
    !Array.isArray(args.metadata)
      ? (args.metadata as Record<string, unknown>)
      : {};
  const storedMediaId = metadata.media_id;
  if (
    !isValidWhatsAppMediaId(storedMediaId) ||
    !isValidWhatsAppMediaId(args.graphMediaId) ||
    args.graphMediaId !== storedMediaId
  ) {
    throw new WhatsAppMediaValidationError("MEDIA_ID_MISMATCH");
  }

  const mimeType = normalizedMimeType(args.graphMimeType);
  if (!mimeType || !TYPE_MIME_ALLOWLIST[args.messageType].has(mimeType)) {
    throw new WhatsAppMediaValidationError("MEDIA_MIME_NOT_ALLOWED");
  }
  const storedMimeType = normalizedMimeType(metadata.mime_type);
  if (storedMimeType && storedMimeType !== mimeType) {
    throw new WhatsAppMediaValidationError("MEDIA_MIME_MISMATCH");
  }

  const fileSize = Number(args.graphFileSize);
  if (
    !Number.isSafeInteger(fileSize) ||
    fileSize <= 0 ||
    fileSize > args.maxBytes
  ) {
    throw new WhatsAppMediaValidationError("MEDIA_SIZE_NOT_ALLOWED");
  }

  return {
    type: args.messageType,
    mediaId: storedMediaId,
    mimeType,
    filename: safeWhatsAppMediaFilename(metadata.filename, mimeType),
    disposition: "inline",
  };
}

export function assertWhatsAppMediaResponseType(
  responseContentType: string | null,
  expectedMimeType: string,
): void {
  if (normalizedMimeType(responseContentType) !== expectedMimeType) {
    throw new WhatsAppMediaValidationError("MEDIA_RESPONSE_TYPE_MISMATCH");
  }
}

export async function readBodyWithLimit(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const contentLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(contentLength) &&
    (contentLength <= 0 || contentLength > maxBytes)
  ) {
    throw new WhatsAppMediaValidationError("MEDIA_SIZE_NOT_ALLOWED");
  }
  if (!response.body) {
    throw new WhatsAppMediaValidationError("MEDIA_BODY_MISSING");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new WhatsAppMediaValidationError("MEDIA_SIZE_NOT_ALLOWED");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) {
    throw new WhatsAppMediaValidationError("MEDIA_BODY_MISSING");
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
