import { normalizePhoneE164 as normalizeContactPhoneE164 } from "./phone.ts";

export type CalendarPatientServiceHint =
  | "consulta"
  | "extracciones"
  | "limpieza"
  | "ortodoncia"
  | "restauraciones"
  | "blanqueamiento";

export interface CalendarPatientTitleHints {
  rawName: string | null;
  name: string | null;
  phoneE164: string | null;
  coverage: "ioma" | "particular" | null;
  isExistingPatient: boolean | null;
  serviceHint: CalendarPatientServiceHint | null;
  orthodonticVisitType: "first_visit" | "in_treatment" | null;
  isPatientCandidate: boolean;
  uncertainties: string[];
}

export interface CalendarPatientContact {
  id: string;
  name: string | null;
  phone_e164?: string | null;
  alternate_phone_e164?: string | null;
}

export interface CalendarPatientContactMatch {
  contactId: string | null;
  reason:
    | "name"
    | "phone_and_name"
    | "ambiguous"
    | "phone_name_conflict"
    | "not_found";
  candidateIds: string[];
}

function normalizeWords(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("es-AR")
    .replace(/[^a-z]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Exact full-name comparison, allowing surname-first titles and accents. */
export function calendarPatientNameKey(
  name: string | null | undefined,
): string {
  return name ? normalizeWords(name).split(" ").sort().join(" ") : "";
}

const SERVICE_PATTERNS: ReadonlyArray<{
  hint: CalendarPatientServiceHint;
  pattern: RegExp;
}> = [
  { hint: "consulta", pattern: /\bconsulta(?:\s+general)?\b/gi },
  { hint: "extracciones", pattern: /\b(?:extracci[oó]n|extracciones)\b/gi },
  { hint: "limpieza", pattern: /\blimpieza(?:\s+dental)?\b/gi },
  { hint: "ortodoncia", pattern: /\b(?:ortodoncia|ortopedia)\b/gi },
  {
    hint: "restauraciones",
    pattern: /\b(?:restauraci[oó]n|restauraciones|arreglos)\b/gi,
  },
  { hint: "blanqueamiento", pattern: /\bblanqueamiento(?:\s+dental)?\b/gi },
];

function emptyHints(): CalendarPatientTitleHints {
  return {
    rawName: null,
    name: null,
    phoneE164: null,
    coverage: null,
    isExistingPatient: null,
    serviceHint: null,
    orthodonticVisitType: null,
    isPatientCandidate: false,
    uncertainties: [],
  };
}

function isNonPatientEvent(summary: string): boolean {
  const words = normalizeWords(summary);
  if (
    /\b(?:evento|bloqueo|bloqueado|horario|horarios|vacaciones|feriado|feriados|reunion|cumpleanos|almuerzo|cancelado|cancelada|cancelar|suspendido|suspendida|reprogramar|reprogramado|reprogramada|ausente)\b/.test(
      words,
    ) ||
    /\b(?:no atiendo|no atender|sin titulo|fuera de consultorio|consultorio cerrado|no viene|no asiste)\b/.test(
      words,
    )
  )
    return true;
  return (
    /\b(?:lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/.test(
      words,
    ) &&
    /\d/.test(summary) &&
    /\b(?:a|hs|horas)\b/.test(words)
  );
}

/** Unlike free-form phone inputs, unlabelled numbers in titles must be complete. */
function titlePhoneE164(value: string): string | null {
  const normalized = normalizeContactPhoneE164(value);
  if (!normalized) return null;
  if (normalized.startsWith("+54")) {
    return /^\+549\d{10}$/.test(normalized) ? normalized : null;
  }
  return /^(?:\+|00)/.test(value.trim()) ? normalized : null;
}

/**
 * Reads Gisela's documented title format: name, TF / 1ra vez, mobile, coverage.
 * Hints only: unknown or conflicting notation is retained as a review warning.
 * TF means "tiene ficha"; neither TF nor 1ra vez implies a dental service.
 */
export function parseCalendarPatientTitle(
  summary: string | null | undefined,
): CalendarPatientTitleHints {
  const hints = emptyHints();
  if (!summary?.trim() || isNonPatientEvent(summary)) return hints;
  let remaining = summary.trim();
  const phones = new Set<string>();
  let invalidPhone = false;
  remaining = remaining.replace(
    /(?<![\p{L}\p{N}])(?:\+|00)?\d[\d ()\t.-]{7,}\d(?![\p{L}\p{N}])/gu,
    (candidate) => {
      const phone = titlePhoneE164(candidate);
      if (phone) phones.add(phone);
      else invalidPhone = true;
      return " ";
    },
  );
  if (phones.size === 1 && !invalidPhone) hints.phoneE164 = [...phones][0];
  if (phones.size > 1)
    hints.uncertainties.push(
      "El título contiene más de un teléfono; elegí cuál corresponde al paciente.",
    );
  if (invalidPhone)
    hints.uncertainties.push(
      "Hay un número que no pudimos reconocer como teléfono completo.",
    );

  const coverages = new Set<"ioma" | "particular">();
  // Gisela abrevia la cobertura en la agenda: "PART", "partic", "particular".
  remaining = remaining.replace(
    /\b(?:ioma|partic(?:ular)?|part)\b/gi,
    (coverage) => {
      coverages.add(
        /^ioma$/i.test(coverage) ? "ioma" : ("particular" as const),
      );
      return " ";
    },
  );
  if (coverages.size === 1) hints.coverage = [...coverages][0];
  if (coverages.size > 1)
    hints.uncertainties.push(
      "El título menciona IOMA y Particular; confirmá la cobertura.",
    );

  let existing = false;
  let firstVisit = false;
  remaining = remaining.replace(
    /\b(?:tf|tiene ficha|paciente existente)\b|\bt\.\s*f(?:\.|\b)/gi,
    () => {
      existing = true;
      return " ";
    },
  );
  remaining = remaining.replace(
    /\b(?:1(?:ra|era)\s+vez|primera\s+vez|paciente\s+nuevo|nuevo\s+paciente)\b/gi,
    () => {
      firstVisit = true;
      return " ";
    },
  );
  if (existing !== firstVisit) hints.isExistingPatient = existing;
  if (existing && firstVisit)
    hints.uncertainties.push(
      "El título indica tanto TF como primera vez; confirmá si tiene ficha.",
    );

  let inTreatment = false;
  remaining = remaining.replace(
    /\ben\s+tratamiento(?:\s+con\s+gisela)?\b/gi,
    () => {
      inTreatment = true;
      return " ";
    },
  );
  const serviceHints = new Set<CalendarPatientServiceHint>();
  // The conjunction belongs to the service, not the patient's surname.
  remaining = remaining.replace(
    /\b(?:ortopedia\s*(?:y|\/)\s*ortodoncia|ortodoncia\s*(?:y|\/)\s*ortopedia)\b/gi,
    () => {
      serviceHints.add("ortodoncia");
      return " ";
    },
  );
  for (const { hint, pattern } of SERVICE_PATTERNS) {
    remaining = remaining.replace(pattern, () => {
      serviceHints.add(hint);
      return " ";
    });
  }
  if (serviceHints.size === 1) hints.serviceHint = [...serviceHints][0];
  if (serviceHints.size > 1)
    hints.uncertainties.push(
      "El título menciona más de un servicio; elegí el motivo del turno.",
    );
  if (
    hints.serviceHint === "ortodoncia" &&
    firstVisit &&
    !existing &&
    !inTreatment
  ) {
    hints.orthodonticVisitType = "first_visit";
  } else if (hints.serviceHint === "ortodoncia" && inTreatment && !firstVisit) {
    hints.orthodonticVisitType = "in_treatment";
  }
  if (inTreatment && (hints.serviceHint !== "ortodoncia" || firstVisit)) {
    hints.uncertainties.push(
      "Confirmá el servicio y el tipo de visita que indica “en tratamiento”.",
    );
  }

  remaining = remaining.replace(
    /\b(?:pendiente de se[nñ]a|ficha sin confirmar|celular sin confirmar|cobertura sin confirmar)\b/gi,
    (marker) => {
      hints.uncertainties.push(
        `El título indica “${marker}”; requiere revisión.`,
      );
      return " ";
    },
  );
  // Anotaciones de cobro: no dicen nada del paciente y el título completo
  // queda igual en la nota interna del turno.
  remaining = remaining.replace(
    /\b(?:dio (?:la )?se[nñ]a|se[nñ][oó]|no cobrar|no cobra|sin cargo)\b/gi,
    " ",
  );
  remaining = remaining.replace(
    /\b(?:rx|tto|tc|cx|iv|endo|orto|control|urgencia|urgente|revisar|conducto|implante|implantes|pr[oó]tesis|corona)\b/gi,
    (notation) => {
      hints.uncertainties.push(
        `Confirmá qué significa “${notation}” antes de elegir el servicio.`,
      );
      return " ";
    },
  );
  // Labels and separators never become part of a newly suggested patient name.
  remaining = remaining.replace(
    /\b(?:paciente|tel[eé]fono|celular|cel|tel)\b\s*:?/gi,
    " ",
  );
  hints.rawName = remaining.trim() || null;
  // Un número corto suelto —un precio, una pieza— no forma parte del nombre.
  // Uno más largo puede ser un teléfono incompleto: queda y fuerza revisión.
  const name = remaining
    .replace(/(?<![\p{L}\p{N}])\d{1,4}(?![\p{L}\p{N}])/gu, " ")
    .replace(/[.,;:|·/()[\]{}]+/g, " ")
    .replace(/\s+[-–—]\s+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[-–—\s]+|[-–—\s]+$/g, "");
  const words = name.match(/[\p{L}\p{M}]+(?:['’\-][\p{L}\p{M}]+)*/gu) ?? [];
  const meaningfulWords = words.filter(
    (word) => !/^(?:de|del|la|las|los|y|da|do|dos|di|van|von)$/i.test(word),
  );
  if (
    meaningfulWords.length > 2 &&
    meaningfulWords.some((word) => word.length < 3)
  ) {
    hints.uncertainties.push(
      "El nombre contiene una inicial o abreviatura; confirmá el nombre completo.",
    );
  }
  const plausibleName =
    meaningfulWords.length >= 2 &&
    meaningfulWords.length <= 6 &&
    /^[\p{L}\p{M}\s'’\-]+$/u.test(name) &&
    name.length <= 120;
  if (plausibleName) hints.name = name;
  else if (name)
    hints.uncertainties.push(
      "No pudimos identificar con seguridad el nombre y apellido del paciente.",
    );
  hints.isPatientCandidate =
    plausibleName &&
    (phones.size > 0 ||
      coverages.size > 0 ||
      existing ||
      firstVisit ||
      serviceHints.size > 0);
  return hints;
}

/** Never resolves a family member from a shared phone without the same full name. */
export function matchCalendarPatientContact(
  hints: CalendarPatientTitleHints,
  contacts: readonly CalendarPatientContact[],
): CalendarPatientContactMatch {
  const none: CalendarPatientContactMatch = {
    contactId: null,
    reason: "not_found",
    candidateIds: [],
  };
  if (!hints.isPatientCandidate || !hints.name) return none;
  const uniqueContacts = [
    ...new Map(contacts.map((contact) => [contact.id, contact])).values(),
  ];
  const key = calendarPatientNameKey(hints.name);
  const nameMatches = uniqueContacts.filter(
    (contact) => calendarPatientNameKey(contact.name) === key,
  );
  const phonesFor = (contact: CalendarPatientContact): string[] =>
    [contact.phone_e164, contact.alternate_phone_e164]
      .filter((phone): phone is string => Boolean(phone))
      .map((phone) => normalizeContactPhoneE164(phone))
      .filter((phone): phone is string => Boolean(phone));
  const phoneMatches = hints.phoneE164
    ? uniqueContacts.filter((contact) =>
        phonesFor(contact).includes(hints.phoneE164!),
      )
    : [];
  const both = nameMatches.filter((contact) =>
    phoneMatches.some((match) => match.id === contact.id),
  );
  if (both.length === 1)
    return {
      contactId: both[0].id,
      reason: "phone_and_name",
      candidateIds: [both[0].id],
    };
  if (both.length > 1)
    return {
      contactId: null,
      reason: "ambiguous",
      candidateIds: both.map((contact) => contact.id),
    };
  if (
    hints.phoneE164 &&
    (phoneMatches.length > 0 ||
      nameMatches.some((contact) => phonesFor(contact).length > 0))
  ) {
    return {
      contactId: null,
      reason: "phone_name_conflict",
      candidateIds: [
        ...new Set(
          [...nameMatches, ...phoneMatches].map((contact) => contact.id),
        ),
      ],
    };
  }
  if (nameMatches.length === 1)
    return {
      contactId: nameMatches[0].id,
      reason: "name",
      candidateIds: [nameMatches[0].id],
    };
  if (nameMatches.length > 1)
    return {
      contactId: null,
      reason: "ambiguous",
      candidateIds: nameMatches.map((contact) => contact.id),
    };
  return none;
}

/** Missing service in the documented title format uses the existing Consulta default. */
export function matchCalendarPatientService(
  hints: CalendarPatientTitleHints,
  services: readonly { id: string; name: string }[],
): string | null {
  if (!hints.isPatientCandidate || hints.uncertainties.length > 0) return null;
  const expected = hints.serviceHint ?? "consulta";
  const serviceNames: Record<CalendarPatientServiceHint, string[]> = {
    consulta: ["consulta", "consulta general"],
    extracciones: ["extracciones", "extraccion"],
    limpieza: ["limpieza", "limpieza dental"],
    ortodoncia: [
      "ortodoncia",
      "ortopedia",
      "ortodoncia ortopedia",
      "ortopedia ortodoncia",
      "ortopedia y ortodoncia",
      "ortodoncia y ortopedia",
    ],
    restauraciones: ["restauraciones", "restauracion", "arreglos"],
    blanqueamiento: ["blanqueamiento", "blanqueamiento dental"],
  };
  const matches = services.filter((service) =>
    serviceNames[expected].includes(normalizeWords(service.name)),
  );
  return matches.length === 1 ? matches[0].id : null;
}
