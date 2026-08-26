import { BUSINESS_CONFIG } from "~/config/business";
import type { Conversation, WhatsAppConsentStatus } from "./inbox-types";

const CUSTOMER_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

function timestamp(value?: string): number | null {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

export function getWhatsAppConsentStatus(
  conversation: Pick<
    Conversation,
    "whatsappConsentStatus" | "whatsappOptInAt" | "whatsappOptOutAt"
  >,
): WhatsAppConsentStatus {
  if (conversation.whatsappConsentStatus) {
    return conversation.whatsappConsentStatus;
  }
  const optedInAt = timestamp(conversation.whatsappOptInAt);
  const optedOutAt = timestamp(conversation.whatsappOptOutAt);

  if (optedOutAt !== null && (optedInAt === null || optedOutAt >= optedInAt)) {
    return "opted_out";
  }
  return optedInAt === null ? "unknown" : "opted_in";
}

export function getCustomerServiceWindow(
  lastInboundMessageAt?: string,
  now = Date.now(),
): { open: boolean; closesAt?: string } {
  const lastInboundAt = timestamp(lastInboundMessageAt);
  if (lastInboundAt === null) return { open: false };

  const closesAt = lastInboundAt + CUSTOMER_SERVICE_WINDOW_MS;
  return {
    open: now < closesAt,
    closesAt: new Date(closesAt).toISOString(),
  };
}

export function canSendCustomerServiceText(
  conversation: Pick<
    Conversation,
    | "lastInboundMessageAt"
    | "whatsappConsentStatus"
    | "whatsappOptInAt"
    | "whatsappOptOutAt"
  >,
  now = Date.now(),
): boolean {
  if (!getCustomerServiceWindow(conversation.lastInboundMessageAt, now).open) {
    return false;
  }
  if (getWhatsAppConsentStatus(conversation) !== "opted_out") return true;

  const lastInboundAt = timestamp(conversation.lastInboundMessageAt);
  const optedOutAt = timestamp(conversation.whatsappOptOutAt);
  return (
    lastInboundAt !== null && optedOutAt !== null && lastInboundAt > optedOutAt
  );
}

export function formatComplianceDate(value?: string): string {
  if (!value) return "Sin registrar";
  const parsed = timestamp(value);
  if (parsed === null) return "Fecha inválida";

  return new Intl.DateTimeFormat("es-AR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: BUSINESS_CONFIG.timezone,
  }).format(new Date(parsed));
}
