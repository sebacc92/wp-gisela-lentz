export type ManualStatusTone = "good" | "attention" | "neutral" | "pending";

export interface ManualStatusCard {
  tone: ManualStatusTone;
  title: string;
  detail: string;
}

export type ManualSectionId =
  | "primeros-pasos"
  | "whatsapp"
  | "turnos"
  | "pacientes"
  | "senas"
  | "calendario"
  | "automatizacion"
  | "problemas-frecuentes"
  | "estado-del-sistema";

export const MANUAL_ROUTE = "/app/manual";

export const manualSections: Array<{
  id: ManualSectionId;
  label: string;
}> = [
  { id: "primeros-pasos", label: "Primeros pasos" },
  { id: "whatsapp", label: "WhatsApp" },
  { id: "turnos", label: "Turnos" },
  { id: "pacientes", label: "Pacientes" },
  { id: "senas", label: "Señas" },
  { id: "calendario", label: "Calendario" },
  { id: "automatizacion", label: "Atención automática" },
  { id: "problemas-frecuentes", label: "Problemas frecuentes" },
  { id: "estado-del-sistema", label: "Estado del sistema" },
];

export function manualSectionHref(section: ManualSectionId): string {
  return `${MANUAL_ROUTE}#${section}`;
}

export interface WhatsAppManualStatusInput {
  checked: boolean;
  accountPresent: boolean | null;
  connected: boolean | null;
  sendingPaused: boolean | null;
  attentionRequired: boolean | null;
  tokenExpired: boolean | null;
  pendingJobs: number | null;
  ambiguousJobs: number | null;
}

/**
 * Convert provider-oriented state into wording that is safe for the person
 * operating the clinic. Unknown state is never presented as healthy.
 */
export function whatsappManualStatus(
  input: WhatsAppManualStatusInput,
): ManualStatusCard {
  if (!input.checked) {
    return {
      tone: "neutral",
      title: "No pudimos comprobar WhatsApp",
      detail: "Actualizá el estado o revisá tu conexión antes de continuar.",
    };
  }
  if (input.accountPresent === null) {
    return {
      tone: "neutral",
      title: "No pudimos comprobar WhatsApp",
      detail: "Actualizá el estado o revisá tu conexión antes de continuar.",
    };
  }
  if (!input.accountPresent) {
    return {
      tone: "neutral",
      title: "WhatsApp todavía no está conectado",
      detail: "La conexión se realiza acompañada, desde Configuración.",
    };
  }
  if (
    input.connected === null ||
    input.sendingPaused === null ||
    input.attentionRequired === null ||
    input.tokenExpired === null ||
    input.pendingJobs === null ||
    input.ambiguousJobs === null
  ) {
    return {
      tone: "neutral",
      title: "No pudimos comprobar WhatsApp",
      detail: "Actualizá el estado o revisá tu conexión antes de continuar.",
    };
  }
  if (input.attentionRequired || input.tokenExpired) {
    return {
      tone: "attention",
      title: "WhatsApp necesita atención",
      detail:
        "Los envíos siguen protegidos. Revisá Configuración antes de intentar responder.",
    };
  }
  if (input.ambiguousJobs > 0) {
    return {
      tone: "attention",
      title: "WhatsApp necesita una revisión",
      detail:
        "Hay una tarea pendiente de confirmación. No inicies otra conexión todavía.",
    };
  }
  if (input.pendingJobs > 0) {
    return {
      tone: "pending",
      title: "WhatsApp se está preparando",
      detail:
        "La conexión está trabajando en segundo plano. Volvé a revisar en unos minutos.",
    };
  }
  if (!input.connected) {
    return {
      tone: "attention",
      title: "WhatsApp no está listo para enviar",
      detail:
        "Revisá la conexión en Configuración antes de atender conversaciones desde acá.",
    };
  }
  if (input.sendingPaused) {
    return {
      tone: "attention",
      title: "WhatsApp está conectado, pero los envíos están pausados",
      detail:
        "Es una protección de seguridad. Revisá Configuración antes de reanudar cualquier envío.",
    };
  }
  return {
    tone: "good",
    title: "WhatsApp está funcionando correctamente",
    detail:
      "La conexión está activa y puede recibir atención desde la bandeja.",
  };
}

export function automationManualStatus(
  enabled: boolean | null,
): ManualStatusCard {
  if (enabled === null) {
    return {
      tone: "neutral",
      title: "No pudimos comprobar la atención automática",
      detail: "Actualizá el estado antes de concluir que está detenida.",
    };
  }
  return enabled
    ? {
        tone: "good",
        title: "Atención automática activa",
        detail:
          "Las conversaciones nuevas pueden recibir respuestas según la configuración vigente.",
      }
    : {
        tone: "neutral",
        title: "Atención automática detenida",
        detail:
          "Los mensajes siguen visibles en la bandeja, pero no se enviarán respuestas automáticas.",
      };
}

export function testModeManualStatus(
  testMode: boolean | null,
): ManualStatusCard {
  if (testMode === null) {
    return {
      tone: "neutral",
      title: "Modo de envío sin comprobar",
      detail:
        "No se pudo confirmar si la plataforma está en prueba o producción.",
    };
  }
  return testMode
    ? {
        tone: "pending",
        title: "Modo prueba activado",
        detail:
          "Los envíos quedan limitados a los números autorizados para una prueba segura.",
      }
    : {
        tone: "good",
        title: "Modo producción activado",
        detail:
          "Los envíos se rigen por las reglas de atención y seguridad configuradas.",
      };
}

export interface CalendarManualStatusInput {
  checked: boolean;
  configured: boolean | null;
  connected: boolean | null;
  status: string | null;
  automationActive?: boolean | null;
  pendingCount: number | null;
  failedCount: number | null;
}

function isKnownCalendarStatus(status: string | null): boolean {
  return (
    status === "incomplete" ||
    status === "connected" ||
    status === "disconnected" ||
    status === "reconnect_required" ||
    status === "pending" ||
    status === "error"
  );
}

export function calendarManualStatus(
  input: CalendarManualStatusInput,
): ManualStatusCard {
  if (!input.checked) {
    return {
      tone: "neutral",
      title: "No pudimos comprobar Google Calendar",
      detail:
        "Volvé a actualizar el estado antes de depender de la sincronización.",
    };
  }
  if (input.configured === null) {
    return {
      tone: "neutral",
      title: "No pudimos comprobar Google Calendar",
      detail:
        "Volvé a actualizar el estado antes de depender de la sincronización.",
    };
  }
  if (!input.configured) {
    return {
      tone: "neutral",
      title: "Google Calendar todavía no está preparado",
      detail:
        "Hace falta completar la configuración técnica antes de conectarlo.",
    };
  }
  if (
    input.connected === null ||
    input.pendingCount === null ||
    input.failedCount === null ||
    !isKnownCalendarStatus(input.status)
  ) {
    return {
      tone: "neutral",
      title: "No pudimos comprobar Google Calendar",
      detail:
        "Volvé a actualizar el estado antes de depender de la sincronización.",
    };
  }
  if (input.failedCount > 0 || input.status === "error") {
    return {
      tone: "attention",
      title: "Google Calendar necesita atención",
      detail:
        "Hay cambios de agenda que necesitan revisión o una nueva conexión.",
    };
  }
  if (input.status === "reconnect_required") {
    return {
      tone: "attention",
      title: "Google Calendar necesita reconectarse",
      detail:
        "Los turnos siguen en la agenda. Pedí ayuda antes de volver a conectar Google Calendar.",
    };
  }
  if (!input.connected) {
    return {
      tone: "neutral",
      title: "Google Calendar no está conectado",
      detail:
        "Los turnos siguen en la agenda; todavía no se reflejan en Google Calendar.",
    };
  }
  if (input.pendingCount > 0 || input.status === "pending") {
    if (input.automationActive !== true) {
      return {
        tone: "pending",
        title: "Google Calendar tiene cambios pendientes",
        detail:
          "La sincronización automática no está activa. Revisá los cambios desde Configuración → Google Calendar.",
      };
    }
    return {
      tone: "pending",
      title: "Google Calendar se está actualizando",
      detail:
        "Los turnos se están sincronizando. Volvé a revisar en unos minutos.",
    };
  }
  if (input.automationActive !== true) {
    return {
      tone: "neutral",
      title: "Google Calendar está conectado",
      detail:
        "La sincronización automática todavía no está activa. Revisá o sincronizá desde Configuración → Google Calendar.",
    };
  }
  return {
    tone: "good",
    title: "Google Calendar está funcionando correctamente",
    detail: "Los turnos confirmados se sincronizan automáticamente.",
  };
}

export function webhookManualStatus(input: {
  checked: boolean;
  lastReceivedAt: string;
  failedCount: number | null;
}): ManualStatusCard {
  if (!input.checked) {
    return {
      tone: "neutral",
      title: "No pudimos comprobar las novedades de WhatsApp",
      detail: "Actualizá el estado antes de concluir que la conexión funciona.",
    };
  }
  if (input.failedCount === null) {
    return {
      tone: "neutral",
      title: "No pudimos comprobar las novedades de WhatsApp",
      detail: "Actualizá el estado antes de concluir que la conexión funciona.",
    };
  }
  if (input.failedCount > 0) {
    return {
      tone: "attention",
      title: "Hay novedades de WhatsApp que requieren atención",
      detail:
        "Revisá Configuración y, si el aviso continúa, contactá a Sebastián.",
    };
  }
  if (!input.lastReceivedAt) {
    return {
      tone: "neutral",
      title: "Todavía no recibimos novedades de WhatsApp",
      detail:
        "Es normal antes de conectar el número o antes del primer mensaje.",
    };
  }
  return {
    tone: "neutral",
    title: "Última novedad de WhatsApp registrada",
    detail:
      "Es la última actualización disponible; no reemplaza una prueba de recepción actual.",
  };
}
