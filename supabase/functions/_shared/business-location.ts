export interface BusinessLocationSettings {
  business_address?: unknown;
  business_location_name?: unknown;
  business_location_address?: unknown;
  business_latitude?: unknown;
  business_longitude?: unknown;
  business_maps_url?: unknown;
}

export interface ResolvedBusinessLocation {
  latitude: number;
  longitude: number;
  name: string;
  address: string;
  displayAddress: string;
  mapsUrl: string;
}

export interface InformationFlowSessionTarget<Context> {
  state: string;
  context?: Context;
  expiresAt?: string | null;
}

export const INFORMATION_FOLLOW_UP_BUTTONS = [
  { id: "flow:new", title: "Sacar un turno" },
  { id: "flow:human", title: "Otra consulta" },
] as const;

const INFORMATION_FLOW_RESUME_PROMPTS: Record<string, string> = {
  choosing_appointment_patient:
    "Seguimos con tu turno 😊 ¿El turno es para vos o para otra persona?",
  selecting_service: "Seguimos con tu turno 😊 ¿Qué tipo de turno necesitás?",
  selecting_orthodontic_visit_type:
    "Seguimos con tu turno 😊 ¿Es tu primera consulta de ortodoncia con Gisela o ya estás en tratamiento con ella?",
  selecting_slot:
    "Seguimos con tu turno 😊 Elegí uno de los horarios disponibles.",
  confirming_appointment:
    "Seguimos con tu turno 😊 ¿Querés pre-reservar el horario que elegiste?",
  selecting_appointment_to_reschedule:
    "Seguimos con tu turno 😊 ¿Qué turno querés reprogramar?",
  confirming_reschedule_request:
    "Seguimos con tu turno 😊 ¿Querés elegir otro horario?",
  selecting_new_slot: "Seguimos con tu turno 😊 Elegí el nuevo horario.",
  confirming_new_slot: "Seguimos con tu turno 😊 ¿Confirmás la reprogramación?",
  selecting_appointment_to_cancel:
    "Seguimos con tu turno 😊 ¿Qué turno querés cancelar?",
  confirming_cancellation:
    "Seguimos con tu turno 😊 ¿Confirmás la cancelación?",
  reviewing_appointments: "Seguimos con tus turnos 😊 ¿Qué querés hacer?",
  waiting_deposit: "Seguimos con tu turno 😊 Quedamos atentos al comprobante.",
};

const PROFILE_RESUME_PROMPTS: Record<string, string> = {
  name: "Seguimos con tu turno 😊 ¿Cuál es tu nombre y apellido?",
  is_existing_patient:
    "Seguimos con tu turno 😊 ¿Ya te atendiste en el consultorio antes?",
  contact_phone: "Seguimos con tu turno 😊 ¿Cuál es tu teléfono de contacto?",
  coverage: "Seguimos con tu turno 😊 ¿Vas a atenderte por IOMA o Particular?",
};

const DEPENDENT_PROFILE_RESUME_PROMPTS: Record<string, string> = {
  name: "Seguimos con el turno 😊 ¿Cuál es el nombre y apellido de la persona que se va a atender?",
  is_existing_patient:
    "Seguimos con el turno 😊 ¿Esa persona ya se atendió en el consultorio antes?",
  contact_phone:
    "Seguimos con el turno 😊 ¿A qué teléfono podemos contactar a esa persona?",
  coverage:
    "Seguimos con el turno 😊 ¿Esa persona se va a atender por IOMA o Particular?",
};

function cleanText(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim().replace(/\s+/g, " ");
  return clean && clean.length <= maximum ? clean : null;
}

export function stableGoogleMapsUrl(value: unknown): string | null {
  const clean = cleanText(value, 2_048);
  if (!clean) return null;
  try {
    const url = new URL(clean);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "www.google.com" ||
      url.username ||
      url.password ||
      url.hash ||
      url.pathname !== "/maps/search/" ||
      url.searchParams.get("api") !== "1" ||
      !url.searchParams.get("query") ||
      !url.searchParams.get("query_place_id")
    ) {
      return null;
    }
    return clean;
  } catch {
    return null;
  }
}

/**
 * Resolves only a complete, explicitly configured business pin. It never
 * geocodes an address or guesses coordinates while handling a conversation.
 */
export function resolveBusinessLocation(
  settings: BusinessLocationSettings,
): ResolvedBusinessLocation | null {
  const name = cleanText(settings.business_location_name, 120);
  const address = cleanText(settings.business_location_address, 500);
  const displayAddress = cleanText(settings.business_address, 500);
  const mapsUrl = stableGoogleMapsUrl(settings.business_maps_url);
  const latitude = settings.business_latitude;
  const longitude = settings.business_longitude;
  if (
    !name ||
    !address ||
    !displayAddress ||
    !mapsUrl ||
    typeof latitude !== "number" ||
    !Number.isFinite(latitude) ||
    latitude < -90 ||
    latitude > 90 ||
    typeof longitude !== "number" ||
    !Number.isFinite(longitude) ||
    longitude < -180 ||
    longitude > 180
  ) {
    return null;
  }
  return { latitude, longitude, name, address, displayAddress, mapsUrl };
}

/** Copy breve previa al pin nativo; la URL estable queda fuera del texto. */
export function conciseBusinessLocationMessage(
  location: Pick<ResolvedBusinessLocation, "displayAddress"> | string,
): string {
  const address = (
    typeof location === "string" ? location : location.displayAddress
  )
    .split(",")
    .slice(0, 2)
    .map((part) => part.trim())
    .filter(Boolean)
    .join(", ")
    .replace(/[.\s]+$/, "");
  return `📍 Estamos en ${address}.`;
}

/** Extracts the configured hours paragraph without repeating location data. */
export function configuredBusinessHoursMessage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const paragraphs = value
    .trim()
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim().replace(/\s+/g, " "))
    .filter(Boolean);
  return (
    paragraphs.find(
      (paragraph) =>
        /\b(?:lunes|martes|miércoles|jueves|viernes|sábado|domingo|horarios?)\b/i.test(
          paragraph,
        ) &&
        !/\b(?:calle|dirección|miramar|provincia|argentina)\b/i.test(paragraph),
    ) ?? null
  );
}

/**
 * Only states waiting for a concrete reply are resumed after a lateral
 * administrative question. Passive/result states deliberately return null.
 */
export function informationFlowResumePrompt(
  state: string,
  context: object = {},
): string | null {
  if (
    state === "confirming_appointment" &&
    (context as { depositRequired?: unknown }).depositRequired === false
  ) {
    return "Seguimos con tu turno 😊 ¿Querés reservar el horario que elegiste? Este turno no requiere seña.";
  }
  if (
    state === "collecting_patient_profile" ||
    state === "collecting_dependent_profile"
  ) {
    const expectedProfileField = (context as { expectedProfileField?: unknown })
      .expectedProfileField;
    const prompts =
      state === "collecting_dependent_profile"
        ? DEPENDENT_PROFILE_RESUME_PROMPTS
        : PROFILE_RESUME_PROMPTS;
    return typeof expectedProfileField === "string"
      ? (prompts[expectedProfileField] ?? null)
      : null;
  }
  return INFORMATION_FLOW_RESUME_PROMPTS[state] ?? null;
}

export function informationFlowSessionTarget<Context>(args: {
  resumeCurrentFlow: boolean;
  state: string;
  context: Context;
  expiresAt: string | null;
}): InformationFlowSessionTarget<Context> {
  if (!args.resumeCurrentFlow) return { state: "idle" };
  return {
    state: args.state,
    context: args.context,
    // Restore the claimed snapshot literally. Rounding it to a TTL can extend
    // the flow and makes a lateral question mutate otherwise untouched state.
    expiresAt: args.expiresAt,
  };
}
