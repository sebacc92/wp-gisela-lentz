import { normalizePhoneE164 as normalizeContactPhoneE164 } from "../../../shared/phone.ts";

export { normalizeContactPhoneE164 };

export type MainMenuIntent =
  | "new"
  | "reschedule"
  | "appointments"
  | "cancel"
  | "info"
  | "human";

export type PatientCoverage = "ioma" | "particular";
export type PatientProfileField =
  | "name"
  | "is_existing_patient"
  | "contact_phone"
  | "coverage";

export const APPOINTMENT_WELCOME_MESSAGE =
  "👋 ¡Hola! Gracias por comunicarte con el consultorio de la Dra. Gisela Lentz. Estoy para ayudarte con turnos y consultas.";

export const ACCEPTED_COVERAGE_MESSAGE =
  "La Dra. Gisela Lentz atiende únicamente por IOMA o de forma particular. No atiende otras obras sociales ni prepagas.";

export const PATIENT_COVERAGE_OPTIONS = [
  { id: "profile:coverage:ioma", title: "IOMA" },
  { id: "profile:coverage:particular", title: "Particular" },
];

export const PATIENT_PROFILE_PROMPTS: Record<PatientProfileField, string> = {
  name: "¿Cuál es tu nombre y apellido?",
  is_existing_patient: "¿Ya te atendiste en el consultorio antes?",
  contact_phone:
    "¿Cuál es tu teléfono de contacto? Podés escribir otro número o elegir este WhatsApp.",
  coverage: `${ACCEPTED_COVERAGE_MESSAGE} ¿Cómo vas a atenderte?`,
};

export interface PatientProfileDraft {
  name?: string;
  isExistingPatient?: boolean;
  contactPhoneConfirmed?: boolean;
  coverage?: PatientCoverage;
  alternatePhoneE164?: string;
}

export interface PatientProfileParseResult {
  values: PatientProfileDraft;
  ambiguous: PatientProfileField[];
}

export const MAIN_MENU_OPTIONS: Array<{
  id: `flow:${MainMenuIntent}`;
  title: string;
}> = [
  { id: "flow:new", title: "Sacar un turno" },
  { id: "flow:reschedule", title: "Reprogramar turno" },
  { id: "flow:appointments", title: "Ver mis turnos" },
  { id: "flow:cancel", title: "Cancelar turno" },
  { id: "flow:info", title: "Horarios y ubicación" },
  // La opción abre una derivación humana sin prometer quién va a tomarla.
  { id: "flow:human", title: "Otra consulta" },
];

export function normalizeUserInput(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("es-AR")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Reconoce únicamente saludos que no contienen además un pedido. Se mantiene
 * deliberadamente acotado para que "hola, quiero un turno" siga llegando al
 * clasificador de intenciones.
 */
export function isConversationGreeting(value: string): boolean {
  const input = normalizeUserInput(value)
    .replace(/\b(?:dra|doctora|gisela)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return /^(?:hola(?: (?:buen dia|buenos dias|buenas|buenas tardes|buenas noches))?|buen dia|buenos dias|buenas|buenas tardes|buenas noches)(?: (?:como estas|como estan|que tal|como va))?$/.test(
    input,
  );
}

/** Mensajes breves de cierre, sin mezclarlos con una nueva consulta. */
export function isConversationAcknowledgement(value: string): boolean {
  const input = normalizeUserInput(value);
  return /^(?:gracias|muchas gracias|mil gracias|dale|ok|okay|okey|joya|perfecto|listo|entendido|genial|buenisimo)(?: (?:muchas |mil )?gracias)?$/.test(
    input,
  );
}

/**
 * Detecta consultas explícitas de precio. No interpreta un monto ni una mención
 * aislada al valor de una seña como una pregunta por aranceles.
 */
export function asksAboutPrice(value: string): boolean {
  const input = normalizeUserInput(value);
  if (!input) return false;
  return (
    /^(?:precio|precios|costo|costos|valor|valores|arancel|aranceles|tarifa|tarifas)\b/.test(
      input,
    ) ||
    /\bcuanto(?:s)? (?:sale|salen|cuesta|cuestan|seria|serian)\b/.test(input) ||
    /\bcuanto(?:s)? (?:esta|estan) (?:la |el |una |un |las |los )?(?:consulta|limpieza(?: dental)?|extraccion(?:es)?|blanqueamiento|ortopedia|ortodoncia|restauracion(?:es)?|arreglo(?:s)?|tratamiento(?:s)?|prestacion(?:es)?|servicio(?:s)?|turno)\b/.test(
      input,
    ) ||
    /\bque sale (?:la |el |una |un |las |los )?(?:consulta|limpieza(?: dental)?|extraccion(?:es)?|blanqueamiento|ortopedia|ortodoncia|restauracion(?:es)?|arreglo(?:s)?|tratamiento(?:s)?|prestacion(?:es)?|servicio(?:s)?|turno)\b/.test(
      input,
    ) ||
    /\b(?:cual|que) (?:es|son|seria|serian) (?:el |la |los |las )?(?:precio|precios|costo|costos|valor|valores|arancel|aranceles|tarifa|tarifas)\b/.test(
      input,
    ) ||
    /\bque (?:precio|precios|costo|costos|valor|valores|arancel|aranceles|tarifa|tarifas)\b/.test(
      input,
    ) ||
    /\b(?:precio|precios|costo|costos|arancel|aranceles|tarifa|tarifas) (?:de|del|para)\b/.test(
      input,
    ) ||
    /\b(?:me|nos) (?:pasas|podrias pasar|podes pasar|decis|dirias|informan|informarias) (?:el |los )?(?:precio|precios|costo|costos|valor|valores|arancel|aranceles|tarifa|tarifas)\b/.test(
      input,
    ) ||
    /\b(?:tiene|tienen|hay) (?:algun )?(?:precio|costo|arancel|tarifa)\b/.test(
      input,
    )
  );
}

const THIRD_PARTY_APPOINTMENT_WORDS =
  "(?:(?:un|una) )?(?:acompanante|otra persona|mi (?:bebe|hija|hijo|madre|mama|padre|papa|pareja|esposa|esposo|marido|mujer|hermana|hermano|abuela|abuelo))";

/**
 * Señala pedidos que el flujo de un solo paciente no puede atribuir con
 * seguridad: varios turnos, otro turno adicional o un turno para un tercero.
 */
export function requestsMultipleAppointments(value: string): boolean {
  const input = normalizeUserInput(value);
  if (!input) return false;
  const appointment = "(?:turnos?|citas?)";
  const several = "(?:2|dos|3|tres|varios|varias)";
  return (
    new RegExp(`\\b${several} ${appointment}\\b`).test(input) ||
    new RegExp(
      `\\b${appointment} (?:para|de) ${several}(?: personas?)?\\b`,
    ).test(input) ||
    new RegExp(
      `\\b(?:otro|otra|segundo|segunda) ${appointment} (?:para|de)\\b`,
    ).test(input) ||
    new RegExp(
      `\\b${appointment}\\b.{0,80}\\bpara mi\\b.{0,80}\\b(?:y|ademas|tambien)\\b.{0,80}\\b(?:otro|otra|${THIRD_PARTY_APPOINTMENT_WORDS})\\b`,
    ).test(input) ||
    new RegExp(
      `\\b(?:tambien|ademas)\\b.{0,40}\\bpara ${THIRD_PARTY_APPOINTMENT_WORDS}\\b`,
    ).test(input) ||
    new RegExp(
      `\\b${appointment}\\b.{0,60}\\bpara ${THIRD_PARTY_APPOINTMENT_WORDS}\\b`,
    ).test(input) ||
    new RegExp(
      `\\b${THIRD_PARTY_APPOINTMENT_WORDS}\\b.{0,60}\\b(?:necesita|necesitan|quiere|quieren|busca|buscan) (?:un |otro )?${appointment}\\b`,
    ).test(input)
  );
}

function uniqueValue<T>(values: T[]): T | null {
  const unique = [...new Set(values)];
  return unique.length === 1 ? unique[0] : null;
}

function titleCaseName(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, " ")
    .split(" ")
    .map((part) =>
      part
        .split(/([-'])/)
        .map((piece) =>
          /^[-']$/.test(piece)
            ? piece
            : `${piece.charAt(0).toLocaleUpperCase("es-AR")}${piece
                .slice(1)
                .toLocaleLowerCase("es-AR")}`,
        )
        .join(""),
    )
    .join(" ");
}

function plausibleFullName(value: string): string | null {
  const candidate = value
    .replace(
      /^\s*(?:1[.)-]?\s*)?(?:(?:nombre(?:\s+y\s+apellido)?\s*[:=-]\s*)|(?:(?:mi nombre es|me llamo)\s+))?/i,
      "",
    )
    .replace(/[.,;:]+$/g, "")
    .trim()
    .replace(/\s+/g, " ");
  if (candidate.length < 3 || candidate.length > 120) return null;
  if (
    /\b(hola|buenas|quiero|necesito|turno|gracias|paciente|ioma|particular|entiendo|hablar|comunicarme|persona|humano|operador)\b/.test(
      normalizeUserInput(candidate),
    )
  ) {
    return null;
  }
  const parts = candidate.split(" ");
  if (parts.length < 2 || parts.length > 8) return null;
  if (
    parts.some(
      (part) =>
        !/^[\p{L}][\p{L}'’-]{0,39}$/u.test(part) ||
        /^(si|sí|no|ioma|particular)$/i.test(part),
    )
  ) {
    return null;
  }
  return titleCaseName(candidate);
}

/** Insurer names here classify questions; only IOMA is accepted as coverage. */
const COVERAGE_TOPIC =
  "(?:coberturas?|obras? social(?:es)?|prepagas?|ioma|particular|osde|swiss medical|pami|galeno|medife|sancor|federada)";
const COVERAGE_WORDS = new RegExp(`\\b${COVERAGE_TOPIC}\\b`);
const COVERAGE_QUESTION = new RegExp(
  `\\b(?:aceptas?|aceptan|atiendes?|atienden|atendes|trabajas?|trabajan|reciben|toman|sirve|puedo (?:ir|atenderme)|se puede(?: atender)?)(?: (?:tambien|con|por|como|de forma|pacientes con|afiliados a|otras?|la|las|una))* ${COVERAGE_TOPIC}\\b`,
);

/** A coverage question is informational, never consent to assign coverage. */
export function asksAboutCoverage(value: string): boolean {
  if (value === "profile:coverage:other") return true;
  const input = normalizeUserInput(value);
  return (
    /\b(?:que|cual|cuales)(?: son| es)?(?: las?| su| tus?)?(?: otras?)? (?:coberturas?|obras? social(?:es)?|prepagas?)\b/.test(
      input,
    ) ||
    COVERAGE_QUESTION.test(input) ||
    /^[¿\s]*(?:ioma|particular)\s*\?$/i.test(value)
  );
}

export function parseCoverageReply(value: string): PatientCoverage | null {
  if (value === "profile:coverage:ioma") return "ioma";
  if (value === "profile:coverage:particular") return "particular";
  const matches: PatientCoverage[] = [];
  for (const part of value.split(/[\n;,|]+/)) {
    if (/[¿?]/.test(part) || asksAboutCoverage(part)) continue;
    const input = normalizeUserInput(part)
      .replace(/^4 /, "")
      .replace(/^(?:mi )?(?:cobertura|obra social)(?: es)? /, "")
      .replace(
        /^.*\bpero (?=(?:elijo|prefiero|quiero atenderme|acepto atenderme)\b)/,
        "",
      );
    // A mention or negation is not a selection. Match only explicit affirmative
    // clauses, including the coverage line of a structured patient profile.
    const choice = input.match(
      /^(?:(?:(?:tengo|uso|cuento con|soy(?: de)?|(?:soy|estoy) afiliad[oa] (?:a|de)|elijo|prefiero|me atiendo|quiero atenderme|voy a atenderme|acepto atenderme|quiero (?:un )?turno|el turno es)(?: por| con| como| de forma)?|por|con|como|de forma) )?(ioma|particular)$/,
    );
    if (choice) matches.push(choice[1] as PatientCoverage);
    else if (
      /^(?:sin cobertura|sin obra social|no tengo (?:cobertura|obra social))$/.test(
        input,
      )
    )
      matches.push("particular");
  }
  return uniqueValue(matches);
}

/** An ambiguous coverage mention must not reuse a previously saved choice. */
export function needsCoverageChoice(value: string): boolean {
  const input = normalizeUserInput(value);
  return (
    (COVERAGE_WORDS.test(input) || /\bafiliad[oa]\b/.test(input)) &&
    parseCoverageReply(value) === null
  );
}

/** Explicit insurer statements must not book using a previously saved IOMA. */
export function hasUnsupportedCoverageStatement(value: string): boolean {
  if (parseCoverageReply(value) !== null) return false;
  const input = normalizeUserInput(value);
  return (
    /\b(?:mi (?:obra social|prepaga|cobertura) es|tengo (?:otra|(?:la |una )?(?:obra social|prepaga|cobertura)))\b/.test(
      input,
    ) ||
    (/\b(?:tengo|uso|cuento con|soy de|(?:soy|estoy) afiliad[oa] (?:a|de)|me atiendo (?:con|por))\b/.test(
      input,
    ) &&
      /\b(?:osde|swiss medical|pami|galeno|medife|sancor|federada)\b/.test(
        input,
      ))
  );
}

/**
 * Reconoce respuestas no admitidas mientras se solicita la cobertura. Se
 * aclaran las dos opciones sin asignar Particular ni prometer otra cobertura.
 * El ID antiguo se reconoce para los botones que ya están en conversaciones.
 */
export function isOtherCoverageReply(value: string): boolean {
  if (value === "profile:coverage:other") return true;
  if (parseCoverageReply(value) !== null) return false;
  const input = normalizeUserInput(value);
  if (
    !input ||
    /^(?:si|no|no se|ninguna|que opciones|cuales son las opciones)$/.test(input)
  ) {
    return false;
  }
  return (
    /^(?:otra|otra cobertura|otra obra social|obra social|prepaga)$/.test(
      input,
    ) ||
    /\b(?:tengo|uso|cuento con|mi cobertura es|mi obra social es|me atiendo (?:con|por)|soy de) [a-z0-9]/.test(
      input,
    ) ||
    /^[a-z][a-z0-9]*(?: [a-z0-9]+){0,2}$/.test(input)
  );
}

export function parseExistingPatientReply(value: string): boolean | null {
  if (value === "profile:existing:yes") return true;
  if (value === "profile:existing:no") return false;
  const input = normalizeUserInput(value);
  if (
    /^(?:si|(?:si )?(?:ya )?soy paciente(?: de (?:la )?(?:doctora|odontologa|dra|gisela|doctora gisela|odontologa gisela))?|paciente si)$/.test(
      input,
    ) ||
    /^(?:si )?(?:ya )?me atendi(?: (?:antes|una vez|en el consultorio|con (?:la )?(?:doctora|odontologa|dra|gisela)))?$/.test(
      input,
    )
  ) {
    return true;
  }
  if (
    /^(?:no|no soy paciente(?: de (?:la )?(?:doctora|odontologa|dra|gisela|doctora gisela|odontologa gisela))?|paciente no|primera vez|es mi primera vez)$/.test(
      input,
    ) ||
    /^(?:no|nunca) me atendi(?: (?:antes|en el consultorio|con (?:la )?(?:doctora|odontologa|dra|gisela)))?$/.test(
      input,
    )
  ) {
    return false;
  }

  const labelled = input.match(
    /(?:sos|soy|era|ya sos|ya soy)?\s*paciente(?: de (?:la )?odontologa| de gisela)?\s*(si|no)\b/,
  );
  if (labelled?.[1] === "si") return true;
  if (labelled?.[1] === "no") return false;
  return null;
}

export function parseAlternatePhoneE164(
  value: string,
  primaryPhoneE164?: string | null,
): string | null {
  const candidates = value.match(/\+[1-9][0-9\t ().-]{7,24}/g) ?? [];
  const normalized = candidates
    .map((candidate) => `+${candidate.replace(/\D/g, "")}`)
    .filter((candidate) => /^\+[1-9][0-9]{7,14}$/.test(candidate))
    .filter((candidate) => candidate !== primaryPhoneE164);
  return uniqueValue(normalized);
}

export function parseContactPhoneReply(
  value: string,
  primaryPhoneE164?: string | null,
): string | null {
  const normalizedPrimary = primaryPhoneE164
    ? normalizeContactPhoneE164(primaryPhoneE164)
    : null;
  if (value === "profile:phone:whatsapp") return normalizedPrimary;

  const input = normalizeUserInput(value);
  if (
    /^(?:si(?: este)?|este(?: mismo)?(?: numero| whatsapp)?|el mismo(?: numero)?|este whatsapp|por aca)$/.test(
      input,
    )
  ) {
    return normalizedPrimary;
  }

  const candidate = value
    .replace(
      /^\s*(?:3[.)-]?\s*)?(?:(?:tel[eé]fono|celular)(?:\s+de\s+contacto)?\s*[:=-]\s*)?/i,
      "",
    )
    .trim();
  return normalizeContactPhoneE164(candidate);
}

function numberedResponseParts(value: string): Map<number, string> {
  const parts = new Map<number, string>();
  for (const line of value.split(/[\n;|]+/)) {
    const match = line.trim().match(/^([1-4])[.)-]?\s*(.+)$/s);
    if (match) parts.set(Number(match[1]), match[2].trim());
  }
  return parts;
}

function explicitResponseParts(value: string): string[] {
  return value
    .split(/[\n;|]+/)
    .map((part) =>
      part
        .trim()
        .replace(/^[\-•]\s*/, "")
        .replace(/[.!]+$/g, "")
        .trim(),
    )
    .filter(Boolean);
}

function positionalResponseParts(value: string): string[] {
  const parts = value
    .split(/[\n;,|]+/)
    .map((part) =>
      part
        .trim()
        .replace(/^[\-•]\s*/, "")
        .trim(),
    )
    .filter(Boolean);
  if (parts.length < 3 || parts.length > 4) return [];
  if (parseExistingPatientReply(parts[1]) === null) return [];
  if (parseCoverageReply(parts.at(-1) ?? "") === null) return [];
  return parts;
}

function labelledName(value: string): string | null {
  const match = value.match(
    /(?:^|[\n;|])\s*(?:1[.)-]?\s*)?nombre(?:\s+y\s+apellido)?\s*[:=-]\s*([^\n;|]+)/i,
  );
  return match ? plausibleFullName(match[1]) : null;
}

function explicitlyIntroducedNames(value: string): string[] {
  return explicitResponseParts(value).flatMap((part) => {
    const match = part.match(/^(?:mi nombre es|me llamo)\s+(.+)$/i);
    const name = match ? plausibleFullName(match[1]) : null;
    return name ? [name] : [];
  });
}

function labelledExistingPatient(value: string): boolean | null {
  const match = value.match(
    /(?:^|[\n;|])\s*(?:2[.)-]?\s*)?(?:sos|soy|era|ya sos|ya soy)?\s*paciente(?: de (?:la )?odont[oó]loga| de gisela)?\s*[:=-]?\s*(s[ií]|no)\b/i,
  );
  return match ? normalizeUserInput(match[1]) === "si" : null;
}

function explicitlyStatedPatientHistory(value: string): boolean[] {
  return explicitResponseParts(value).flatMap((part) => {
    const parsed = parseExistingPatientReply(part);
    return parsed === null ? [] : [parsed];
  });
}

function explicitlyLabelledContactPhones(value: string): string[] {
  return explicitResponseParts(value).flatMap((part) => {
    const match = part.match(
      /^(?:3[.)-]?\s*)?(?:(?:mi|el)\s+)?(?:tel[eé]fono|celular)(?:\s+de\s+contacto)?\s*(?::|=|-|es)\s*(.+)$/i,
    );
    return match?.[1]?.trim() ? [match[1].trim()] : [];
  });
}

/**
 * Extrae sólo datos de alta que pueden identificarse sin inferencias clínicas
 * ni modelos externos. Las respuestas ambiguas quedan sin completar para que el
 * flujo pregunte únicamente ese dato.
 */
export function parsePatientProfileReply(
  value: string,
  options: {
    expectedField?: PatientProfileField | null;
    primaryPhoneE164?: string | null;
  } = {},
): PatientProfileParseResult {
  const values: PatientProfileDraft = {};
  const ambiguous = new Set<PatientProfileField>();
  const numbered = numberedResponseParts(value);
  const positional = positionalResponseParts(value);
  const expected = options.expectedField ?? null;

  const nameCandidates = [
    labelledName(value),
    ...explicitlyIntroducedNames(value),
    numbered.has(1) ? plausibleFullName(numbered.get(1) ?? "") : null,
    positional.length ? plausibleFullName(positional[0]) : null,
    expected === "name" ? plausibleFullName(value) : null,
  ].filter((candidate): candidate is string => Boolean(candidate));
  const name = uniqueValue(nameCandidates);
  if (name) values.name = name;
  else if (nameCandidates.length > 1) ambiguous.add("name");

  const existingCandidates: boolean[] = [];
  const labelledExisting = labelledExistingPatient(value);
  if (labelledExisting !== null) existingCandidates.push(labelledExisting);
  existingCandidates.push(...explicitlyStatedPatientHistory(value));
  if (numbered.has(2)) {
    const parsed = parseExistingPatientReply(numbered.get(2) ?? "");
    if (parsed !== null) existingCandidates.push(parsed);
  }
  if (positional.length) {
    const parsed = parseExistingPatientReply(positional[1]);
    if (parsed !== null) existingCandidates.push(parsed);
  }
  if (expected === "is_existing_patient") {
    const parsed = parseExistingPatientReply(value);
    if (parsed !== null) existingCandidates.push(parsed);
  }
  const existing = uniqueValue(existingCandidates);
  if (existing !== null) values.isExistingPatient = existing;
  else if (existingCandidates.length > 1) ambiguous.add("is_existing_patient");

  const phoneCandidates = [
    ...explicitlyLabelledContactPhones(value),
    numbered.has(3) ? (numbered.get(3) ?? null) : null,
    positional.length === 4 ? positional[2] : null,
    expected === "contact_phone" ? value : null,
  ]
    .filter((candidate): candidate is string => Boolean(candidate))
    .map((candidate) =>
      parseContactPhoneReply(candidate, options.primaryPhoneE164),
    )
    .filter((candidate): candidate is string => Boolean(candidate));
  const contactPhone = uniqueValue(phoneCandidates);
  if (contactPhone) {
    values.contactPhoneConfirmed = true;
    if (contactPhone !== options.primaryPhoneE164) {
      values.alternatePhoneE164 = contactPhone;
    }
  } else if (phoneCandidates.length > 1) {
    ambiguous.add("contact_phone");
  }

  const coverageCandidates: PatientCoverage[] = [];
  const coverage = parseCoverageReply(value);
  if (coverage) coverageCandidates.push(coverage);
  if (numbered.has(4)) {
    const parsed = parseCoverageReply(numbered.get(4) ?? "");
    if (parsed) coverageCandidates.push(parsed);
  }
  if (positional.length) {
    const parsed = parseCoverageReply(positional.at(-1) ?? "");
    if (parsed) coverageCandidates.push(parsed);
  }
  const uniqueCoverage = uniqueValue(coverageCandidates);
  if (uniqueCoverage) values.coverage = uniqueCoverage;
  else if (
    /\bioma\b/.test(normalizeUserInput(value)) &&
    /\bparticular\b/.test(normalizeUserInput(value))
  ) {
    ambiguous.add("coverage");
  }

  return { values, ambiguous: [...ambiguous] };
}

export function missingPatientProfileFields(profile: {
  name?: string | null;
  isExistingPatient?: boolean | null;
  contactPhoneConfirmed?: boolean | null;
  coverage?: PatientCoverage | null;
}): PatientProfileField[] {
  const missing: PatientProfileField[] = [];
  if (!profile.name || !plausibleFullName(profile.name)) missing.push("name");
  if (
    profile.isExistingPatient === null ||
    profile.isExistingPatient === undefined
  ) {
    missing.push("is_existing_patient");
  }
  if (profile.contactPhoneConfirmed !== true) {
    missing.push("contact_phone");
  }
  if (profile.coverage !== "ioma" && profile.coverage !== "particular") {
    missing.push("coverage");
  }
  return missing;
}

export function formatDepositAmountArs(amount: number): string {
  if (!Number.isSafeInteger(amount) || amount < 0) return "$0";
  return `$${new Intl.NumberFormat("es-AR", {
    maximumFractionDigits: 0,
  }).format(amount)}`;
}

export function renderConfiguredMessage(
  template: string,
  values: Record<string, string | number>,
): string {
  return template
    .replace(/\{([a-z][a-z0-9_]*)\}/g, (placeholder, key: string) =>
      Object.prototype.hasOwnProperty.call(values, key)
        ? String(values[key])
        : placeholder,
    )
    .trim();
}

const DEFAULT_DEPOSIT_PROOF_REVIEW_MESSAGE =
  "Recibimos tu comprobante. Vamos a revisarlo antes de confirmar el turno.";

export function depositProofReviewMessage(
  configuredMessage: string | null | undefined,
  late: boolean,
): string {
  if (late) {
    return "Recibimos tu comprobante, pero la pre-reserva ya venció. Vamos a revisar el caso antes de confirmar un turno.";
  }
  const configured = configuredMessage?.trim() ?? "";
  const candidate = configured
    ? `${configured} Vamos a revisarlo antes de confirmar el turno.`
    : DEFAULT_DEPOSIT_PROOF_REVIEW_MESSAGE;
  return candidate.length <= 4096 &&
    !/\{[A-Za-z][A-Za-z0-9_]*\}/.test(candidate)
    ? candidate
    : DEFAULT_DEPOSIT_PROOF_REVIEW_MESSAGE;
}

export function resolveMainMenuIntent(value: string): MainMenuIntent | null {
  const interactive = MAIN_MENU_OPTIONS.find((option) => option.id === value);
  if (interactive) return interactive.id.slice(5) as MainMenuIntent;

  const input = normalizeUserInput(value);
  if (/^(reprogramar|cambiar|mover|modificar)$/.test(input)) {
    return "reschedule";
  }
  if (
    /\b(reprogramar|reprogramacion|cambiar|mover|modificar)\b.*\bturno\b/.test(
      input,
    ) ||
    /\bturno\b.*\b(reprogramar|cambiar|mover|modificar)\b/.test(input)
  ) {
    return "reschedule";
  }
  if (/^(cancelar|anular)$/.test(input)) return "cancel";
  if (
    /\b(cancelar|anular|dar de baja)\b.*\bturno\b/.test(input) ||
    /\bturno\b.*\b(cancelar|anular|dar de baja)\b/.test(input)
  ) {
    return "cancel";
  }
  if (/^(mis turnos|ver turnos|consultar turnos|turnos)$/.test(input)) {
    return "appointments";
  }
  if (
    /\b(mis|ver|consultar|proximos?)\b.*\bturnos?\b/.test(input) ||
    /\bturnos?\b.*\b(tengo|proximos?|agendados?)\b/.test(input)
  ) {
    return "appointments";
  }
  if (
    /^(turno|nuevo turno|sacar turno|solicitar turno|pedir turno)$/.test(input)
  ) {
    return "new";
  }
  if (
    /\b(sacar|solicitar|pedir|reservar|agendar|necesito|quiero|nuevo)\b.*\bturno\b/.test(
      input,
    ) ||
    /\bturno\b.*\b(nuevo|disponible)\b/.test(input)
  ) {
    return "new";
  }
  if (
    /\b(horarios?|ubicacion|direccion|como llegar|donde estan)\b/.test(input)
  ) {
    return "info";
  }
  if (
    /\b(gisela|recepcion|recepcionista|persona|humano|operador|asesor)\b/.test(
      input,
    )
  ) {
    return "human";
  }
  return null;
}

export function isMainMenuRequest(value: string): boolean {
  const input = normalizeUserInput(value);
  return /^(menu|inicio|volver|volver al menu|menu principal|salir)$/.test(
    input,
  );
}

export function nextInvalidAttempt(current?: number): {
  attempts: number;
  shouldHandoff: boolean;
} {
  const previous =
    Number.isSafeInteger(current) && (current ?? 0) >= 0 ? (current ?? 0) : 0;
  const attempts = previous + 1;
  return { attempts, shouldHandoff: attempts >= 2 };
}

const AFFIRMATIVE =
  /^(si|confirmar|confirmo|dale|ok|okay|de acuerdo|correcto)$/;
const NEGATIVE = /^(no|volver|atras|cancelar|conservar turno)$/;

export function resolveAppointmentConfirmation(
  value: string,
): "confirm" | "other" | "menu" | null {
  if (value === "appointment:confirm") return "confirm";
  if (value === "appointment:other") return "other";
  if (value === "appointment:cancel") return "menu";
  const input = normalizeUserInput(value);
  if (/^(reservar turno|pre reservar)$/.test(input) && !/[¿?]/.test(value))
    return "confirm";
  if (AFFIRMATIVE.test(input)) return "confirm";
  if (
    /^(otro|otra opcion|elegir otro|otro horario|cambiar horario)$/.test(input)
  )
    return "other";
  if (NEGATIVE.test(input) || isMainMenuRequest(input)) return "menu";
  return null;
}

export function resolveRescheduleRequest(value: string): "yes" | "no" | null {
  if (value === "reschedule:yes") return "yes";
  if (value === "reschedule:no") return "no";
  const input = normalizeUserInput(value);
  if (AFFIRMATIVE.test(input) || input === "reprogramar") return "yes";
  if (NEGATIVE.test(input)) return "no";
  return null;
}

export function resolveRescheduleConfirmation(
  value: string,
): "confirm" | "other" | "back" | null {
  if (value === "reschedule:confirm") return "confirm";
  if (value === "reschedule:other") return "other";
  if (value === "reschedule:back") return "back";
  const input = normalizeUserInput(value);
  if (AFFIRMATIVE.test(input)) return "confirm";
  if (
    /^(otro|otra opcion|elegir otro|otro horario|cambiar horario)$/.test(input)
  )
    return "other";
  if (NEGATIVE.test(input) || isMainMenuRequest(input)) return "back";
  return null;
}

export function resolveCancellationConfirmation(
  value: string,
): "yes" | "no" | null {
  if (value === "cancel:yes") return "yes";
  if (value === "cancel:no") return "no";
  const input = normalizeUserInput(value);
  if (
    AFFIRMATIVE.test(input) ||
    /^(cancelar|cancelar turno|si cancelar|confirmar cancelacion)$/.test(input)
  ) {
    return "yes";
  }
  if (NEGATIVE.test(input) || input === "no cancelar") return "no";
  return null;
}

export function parseSlotIndex(
  value: string,
  slotCount: number,
): number | null {
  const match = /^slot:(\d+)$/.exec(value);
  if (!match) return null;
  const index = Number(match[1]);
  return Number.isSafeInteger(index) && index >= 0 && index < slotCount
    ? index
    : null;
}

/**
 * Acepta el identificador de WhatsApp, un número visible empezando en uno o el
 * texto completo de una opción. El texto debe coincidir de forma única: no se
 * adivinan fechas, días ni franjas parciales.
 */
export function parseSlotSelection(
  value: string,
  optionLabels: string[],
): number | null {
  const encoded = parseSlotIndex(value, optionLabels.length);
  if (encoded !== null) return encoded;

  const input = normalizeUserInput(value);
  const numbered = /^(?:opcion )?(\d+)$/.exec(input);
  if (numbered) {
    const oneBased = Number(numbered[1]);
    return Number.isSafeInteger(oneBased) &&
      oneBased >= 1 &&
      oneBased <= optionLabels.length
      ? oneBased - 1
      : null;
  }

  if (!input) return null;
  const exactMatches = optionLabels.flatMap((label, index) =>
    normalizeUserInput(label) === input ? [index] : [],
  );
  return uniqueValue(exactMatches);
}

export function parseProfessionalReply(value: string): string | null {
  if (value === "pro:any") return "any";
  const match =
    /^pro:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.exec(
      value,
    );
  return match?.[1] ?? null;
}

export function parseServiceReply(value: string): string | null {
  const match =
    /^svc:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.exec(
      value,
    );
  return match?.[1] ?? null;
}

export function parseAppointmentSelection(
  value: string,
  action: "reschedule" | "cancel",
): string | null {
  const match = new RegExp(
    `^turn:${action}:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$`,
    "i",
  ).exec(value);
  return match?.[1] ?? null;
}

/** Cuántos horarios se ofrecen por día. Mostrar todos los del primer día
 * abierto llenaba la lista con un solo día y dejaba afuera a quien no podía
 * justamente ese día. */
export const MAX_SLOTS_OFFERED_PER_DAY = 2;

/**
 * Arma la lista de horarios a ofrecer tomando unos pocos de cada día, en orden,
 * hasta llegar al total. Recibe los horarios ya agrupados por día para que el
 * reparto no dependa de zonas horarias.
 */
export function selectSlotsForOffer<T>(
  slotsByDay: T[][],
  perDay: number,
  limit: number,
): T[] {
  const selected: T[] = [];
  for (const day of slotsByDay) {
    for (const slot of day.slice(0, Math.max(0, perDay))) {
      if (selected.length >= limit) return selected;
      selected.push(slot);
    }
  }
  return selected;
}
