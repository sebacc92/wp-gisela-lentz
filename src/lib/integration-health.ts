import type { GoogleCalendarOperationalStatus } from "./google-calendar-operational-status";

/**
 * Aviso de salud de las integraciones para el panel de inicio.
 *
 * El banner sólo avisa; no reconecta ni sincroniza nada. La regla que ordena
 * todo es que **el silencio nunca significa "está bien"**: si no pudimos leer
 * el estado, se dice que no se pudo leer. Un permiso vencido que no se ve es
 * peor que un aviso de más, porque los mensajes dejan de salir sin que nadie
 * se entere.
 *
 * Sobre WhatsApp sólo se usa lo que el navegador puede leer de verdad:
 * `whatsapp_settings` es legible por cualquier usuario activo, mientras que
 * `whatsapp_coexistence_accounts` —donde vive el estado fino del token— es
 * exclusiva de `service_role`. El detalle del token queda para Configuración,
 * que sí pasa por una edge function.
 */

export type IntegrationHealthSeverity = "critical" | "warning" | "unknown";

export interface IntegrationHealthAlert {
  id: "whatsapp" | "google-calendar";
  severity: IntegrationHealthSeverity;
  title: string;
  detail: string;
  actionLabel: string;
  actionHref: string;
  /** Sólo ADMIN puede reconectar; el resto ve el aviso sin acción. */
  adminOnly: boolean;
}

export interface WhatsAppHealthInput {
  integrationStatus: "incomplete" | "connected" | "error" | null;
  lastError: string | null;
  sendingPaused: boolean | null;
  sendingPauseReason: string | null;
}

const WHATSAPP_HREF = "/app/settings?section=whatsapp";
const CALENDAR_HREF = "/app/settings?section=google";

/** Motivos de pausa que Meta impone y que exigen intervención, no espera. */
const PAUSE_REASON_COPY: Record<string, string> = {
  META_QUALITY_RED:
    "Meta bajó la calidad del número a roja y frenamos los envíos para no arriesgar el bloqueo.",
};

function whatsappAlert(
  input: WhatsAppHealthInput,
): IntegrationHealthAlert | null {
  if (input.integrationStatus === null) {
    return {
      id: "whatsapp",
      severity: "unknown",
      title: "No pudimos leer el estado de WhatsApp",
      detail: "Volvé a consultarlo antes de depender del envío automático.",
      actionLabel: "Revisar WhatsApp",
      actionHref: WHATSAPP_HREF,
      adminOnly: false,
    };
  }

  if (input.integrationStatus === "error") {
    return {
      id: "whatsapp",
      severity: "critical",
      title: "WhatsApp necesita volver a conectarse",
      detail:
        input.lastError?.trim() ||
        "La última verificación con Meta falló. Los envíos pueden estar detenidos.",
      actionLabel: "Revisar WhatsApp",
      actionHref: WHATSAPP_HREF,
      adminOnly: true,
    };
  }

  // La pausa es una decisión de seguridad ya tomada: mientras siga puesta no
  // sale ningún mensaje, así que se avisa aunque la conexión esté sana.
  if (input.sendingPaused === true) {
    const reason = input.sendingPauseReason?.trim() ?? "";
    return {
      id: "whatsapp",
      severity: "critical",
      title: "Los envíos de WhatsApp están pausados",
      detail:
        PAUSE_REASON_COPY[reason] ||
        "No sale ningún mensaje hasta reanudarlos desde Configuración.",
      actionLabel: "Revisar envíos",
      actionHref: WHATSAPP_HREF,
      adminOnly: true,
    };
  }

  // Una instalación que todavía no terminó no es una falla: se avisa sin
  // alarmar, porque la agenda funciona igual.
  if (input.integrationStatus === "incomplete") {
    return {
      id: "whatsapp",
      severity: "warning",
      title: "WhatsApp todavía no está conectado",
      detail: "La agenda funciona igual; no se envían mensajes automáticos.",
      actionLabel: "Conectar WhatsApp",
      actionHref: WHATSAPP_HREF,
      adminOnly: true,
    };
  }

  return null;
}

/**
 * Calendar sólo entra al banner cuando hace falta volver a autorizar o cuando
 * la sincronización quedó frenada. Los conflictos y el detalle fino ya los
 * muestra `GoogleCalendarStatusBlock`; duplicarlos acá agrega ruido.
 */
function googleCalendarAlert(
  status: GoogleCalendarOperationalStatus | null,
): IntegrationHealthAlert | null {
  if (status === null) {
    return {
      id: "google-calendar",
      severity: "unknown",
      title: "No pudimos leer el estado de Google Calendar",
      detail: "La agenda de la aplicación sigue disponible.",
      actionLabel: "Ver configuración",
      actionHref: CALENDAR_HREF,
      adminOnly: false,
    };
  }

  // Nunca conectado no es lo mismo que desconectado: no hay nada que reautorizar.
  if (!status.configured) return null;

  if (status.status === "reconnect_required" || !status.connected) {
    return {
      id: "google-calendar",
      severity: "critical",
      title: "Google Calendar necesita volver a autorizarse",
      detail:
        "Se perdió el permiso de Google. La agenda de la aplicación sigue disponible, pero no se sincroniza.",
      actionLabel: "Reconectar Calendar",
      actionHref: CALENDAR_HREF,
      adminOnly: true,
    };
  }

  if (status.inboundSyncState === "full_resync_required") {
    return {
      id: "google-calendar",
      severity: "warning",
      title: "Google Calendar necesita una resincronización completa",
      detail:
        "La sincronización incremental se interrumpió y quedó frenada hasta revisarla.",
      actionLabel: "Revisar Calendar",
      actionHref: CALENDAR_HREF,
      adminOnly: true,
    };
  }

  return null;
}

const SEVERITY_ORDER: Record<IntegrationHealthSeverity, number> = {
  critical: 0,
  warning: 1,
  unknown: 2,
};

export function integrationHealthAlerts(input: {
  whatsapp: WhatsAppHealthInput;
  googleCalendar: GoogleCalendarOperationalStatus | null;
}): IntegrationHealthAlert[] {
  return [
    whatsappAlert(input.whatsapp),
    googleCalendarAlert(input.googleCalendar),
  ]
    .filter((alert): alert is IntegrationHealthAlert => alert !== null)
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}
