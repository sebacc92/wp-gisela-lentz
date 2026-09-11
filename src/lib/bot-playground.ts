/**
 * Simulador de la automatización de WhatsApp.
 *
 * Responde una sola pregunta: **con este mensaje, ¿qué haría el bot?**. No
 * envía nada, no toca conversaciones reales y no consulta la base: es una
 * lectura de las reglas de ruteo aplicadas a un texto de prueba.
 *
 * Las reglas viven duplicadas a propósito. El clasificador real corre en Deno
 * (`supabase/functions/_shared/incoming-message.ts`) y arrastra dependencias
 * del runtime que no entran al bundle del navegador. Para que la copia no se
 * despegue, `bot-playground-contract.test.ts` compara estas expresiones contra
 * el fuente de la function y falla si alguien cambia una sola de las dos.
 */

export type PlaygroundMessageType =
  | "text"
  | "interactive"
  | "image"
  | "document"
  | "audio";

export type PlaygroundRoute =
  | "automatic"
  | "priority_human"
  | "human_review"
  | "opt_out"
  | "opt_in"
  | "paused";

export interface PlaygroundInput {
  body: string;
  type: PlaygroundMessageType;
  /** Kill switch global de automatizaciones. */
  automationsEnabled: boolean;
  /** `auto` o `manual` en la conversación simulada. */
  automationMode: "auto" | "manual";
  /** El contacto ya pidió no recibir mensajes. */
  optedOut: boolean;
}

export interface PlaygroundResult {
  route: PlaygroundRoute;
  /** Si el bot llegaría a responder solo. */
  botWouldAnswer: boolean;
  title: string;
  detail: string;
  /** Frase normalizada, tal como la ve el clasificador. */
  normalizedPhrase: string;
  /** Reglas que se activaron, para poder explicar el resultado. */
  matched: string[];
}

/** Igual que `normalizedPhrase` en la function: sin acentos ni puntuación. */
export function normalizedPhrase(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("es-AR")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export const PRIORITY_PATTERN =
  /\b(urgencias?|emergencias?|dolor intenso|dolor fuerte|sangrado|accidente|traumatismo)\b/;

export const HUMAN_REVIEW_PATTERN =
  /\b(diagnostico|receta|medicacion|dosis|historia clinica|resultado de estudio|urgencias?|emergencias?|dolor intenso|dolor fuerte|sangrado|accidente|traumatismo)\b/;

export const OPT_OUT_PHRASES = new Set([
  "baja",
  "stop",
  "unsubscribe",
  "stop messages",
  "no more messages",
  "cancelar suscripcion",
  "desuscribirme",
  "dejar de recibir mensajes",
  "no quiero recibir mensajes",
  "no quiero recibir mas mensajes",
  "no deseo recibir mensajes",
  "no deseo recibir mas mensajes",
  "no recibir mas mensajes",
  "no me escriban mas",
  "no me escribas mas",
  "no me manden mas mensajes",
  "no me mandes mas mensajes",
  "deja de escribirme",
  "no quiero que me escribas mas",
  "quiero darme de baja",
  "denme de baja",
]);

export const OPT_IN_PHRASES = new Set([
  "acepto recibir recordatorios de turnos",
]);

/** Un adjunto que el bot todavía no sabe leer siempre deriva a una persona. */
const OPAQUE_TYPES = new Set<PlaygroundMessageType>([
  "image",
  "document",
  "audio",
]);

export function consentDecisionFromText(
  value: string,
): "opt_in" | "opt_out" | null {
  const phrase = normalizedPhrase(value);
  const politePhrase = phrase
    .replace(/^por favor /, "")
    .replace(/ por favor$/, "");
  const explicitOptOut =
    OPT_OUT_PHRASES.has(politePhrase) ||
    /^(baja|stop) por favor$/.test(phrase) ||
    /^(por favor )?(quiero )?(darme|denme) de baja( por favor)?$/.test(phrase);
  if (explicitOptOut) return "opt_out";
  return OPT_IN_PHRASES.has(phrase) ? "opt_in" : null;
}

export function simulateBotRouting(input: PlaygroundInput): PlaygroundResult {
  const phrase = normalizedPhrase(input.body);
  const matched: string[] = [];

  const consent =
    input.type === "text" || input.type === "interactive"
      ? consentDecisionFromText(input.body)
      : null;

  if (consent === "opt_out") {
    return {
      route: "opt_out",
      botWouldAnswer: false,
      title: "Se interpreta como una baja",
      detail:
        "Queda registrado el pedido de no recibir más mensajes. A partir de ahí no se le escribe, ni siquiera recordatorios.",
      normalizedPhrase: phrase,
      matched: ["frase explícita de baja"],
    };
  }

  if (consent === "opt_in") {
    return {
      route: "opt_in",
      botWouldAnswer: true,
      title: "Se interpreta como consentimiento",
      detail: "Queda registrado que acepta recibir recordatorios de turnos.",
      normalizedPhrase: phrase,
      matched: ["frase explícita de alta"],
    };
  }

  const opaque = OPAQUE_TYPES.has(input.type);
  if (opaque) matched.push(`adjunto de tipo ${input.type}`);

  const priority =
    (input.type === "text" || input.type === "interactive") &&
    PRIORITY_PATTERN.test(phrase);
  if (priority) matched.push("menciona una urgencia");

  const humanReview = opaque || HUMAN_REVIEW_PATTERN.test(phrase);
  if (humanReview && !priority && !opaque) {
    matched.push("menciona información clínica");
  }

  if (input.optedOut) {
    return {
      route: "paused",
      botWouldAnswer: false,
      title: "El contacto pidió no recibir mensajes",
      detail:
        "Con una baja registrada la automatización no responde, sin importar el contenido.",
      normalizedPhrase: phrase,
      matched: ["baja registrada"],
    };
  }

  if (!input.automationsEnabled) {
    return {
      route: "paused",
      botWouldAnswer: false,
      title: "El bot global está apagado",
      detail:
        priority || humanReview
          ? "El mensaje igual quedaría marcado para atención humana."
          : "El mensaje queda en la bandeja esperando una respuesta escrita.",
      normalizedPhrase: phrase,
      matched: [...matched, "kill switch global apagado"],
    };
  }

  if (priority) {
    return {
      route: "priority_human",
      botWouldAnswer: false,
      title: "Deriva a atención humana con prioridad",
      detail:
        "Gisela agenda y cotiza las urgencias personalmente, así que el bot no sigue el flujo de reserva.",
      normalizedPhrase: phrase,
      matched,
    };
  }

  if (humanReview) {
    return {
      route: "human_review",
      botWouldAnswer: false,
      title: "Deriva a atención humana",
      detail: opaque
        ? "El bot no interpreta este adjunto por su cuenta: queda para revisar."
        : "El mensaje toca información clínica, así que no sigue solo.",
      normalizedPhrase: phrase,
      matched,
    };
  }

  if (input.automationMode === "manual") {
    return {
      route: "paused",
      botWouldAnswer: false,
      title: "La conversación está en pausa manual",
      detail: "Alguien tomó este chat. El bot no responde hasta reactivarlo.",
      normalizedPhrase: phrase,
      matched: ["conversación en modo manual"],
    };
  }

  return {
    route: "automatic",
    botWouldAnswer: true,
    title: "El bot respondería solo",
    detail:
      "El mensaje entra al flujo automático: reservar, consultar, cancelar o reprogramar según lo que pida.",
    normalizedPhrase: phrase,
    matched: matched.length > 0 ? matched : ["sin reglas de derivación"],
  };
}
