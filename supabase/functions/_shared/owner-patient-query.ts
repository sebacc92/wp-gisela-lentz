import { normalizeUserInput } from "./automation-flow.ts";

const MAX_PATIENT_QUERY_LENGTH = 60;

function trimRequestPunctuation(value: string): string {
  return value.replace(/^[¿¡,;:.!?\s]+/u, "").replace(/[¿¡,;:.!?\s]+$/u, "");
}

function patientRequestPhrase(body: string): string {
  let phrase = trimRequestPunctuation(
    body.normalize("NFC").replace(/\s+/gu, " ").trim(),
  );
  // Estas cortesías no forman parte del nombre que se busca en la base.
  phrase = phrase.replace(/(?:[,;.!?\s]+(?:por\s+favor|gracias))+$/iu, "");
  for (let index = 0; index < 2; index += 1) {
    phrase = trimRequestPunctuation(
      phrase.replace(
        /^(?:hola|buenas(?:\s+(?:tardes|noches))?|buenos\s+d[ií]as|por\s+favor)(?:[,;:.!?\s]+|$)/iu,
        "",
      ),
    );
  }
  phrase = phrase.replace(/^(?:me\s+)?(?:pod[eé]s|puedes|podr[ií]as)\s+/iu, "");
  phrase = phrase.replace(
    /^(?:(?:me\s+)?(?:pas[aá]s|pasar[ií]as|das|dar[ií]as|dec[ií]s|dir[ií]as|mostr[aá]s|mostrar[ií]as)|pas[aá]me|dame|dec[ií]me|mostr[aá]me|pasar(?:me)?|dar(?:me)?|decir(?:me)?|mostrar(?:me)?|(?:quiero|necesito)(?:\s+(?:ver|saber|conocer|consultar))?)\s+/iu,
    "",
  );
  return trimRequestPunctuation(phrase);
}

function validPatientQuery(query: string): boolean {
  if (query.length < 2 || query.length > MAX_PATIENT_QUERY_LENGTH) return false;
  // Sólo nombres: no convertir fechas, teléfonos, instrucciones adicionales o
  // patrones SQL en una búsqueda amplia. Se conservan acentos y apellidos.
  if (!/^[\p{L}\p{M}][\p{L}\p{M}'’ .-]*[\p{L}\p{M}.]$/u.test(query)) {
    return false;
  }
  const normalized = normalizeUserInput(query);
  if (
    /^(?:todos|todas|todo|paciente|pacientes|agenda|turno|turnos|datos|informacion|telefono|mis pacientes|los pacientes|las pacientes|el paciente|la paciente)$/.test(
      normalized,
    )
  )
    return false;
  if (
    /\b(?:hoy|manana|semana|mes|ano|proximos|proximas|agendados|disponibles|turnos?|pacientes?|datos|informacion)\b/.test(
      normalized,
    )
  )
    return false;
  // Un día seguido de un apellido puede ser un nombre (Domingo Pérez). Un
  // día solo o con un modificador temporal es un pedido de agenda.
  return !/^(?:(?:el|del|este|esta|proximo|proxima)\s+)*(?:lunes|martes|miercoles|jueves|viernes|sabado|domingo)(?:\s+(?:que viene|proximo|proxima|siguiente|pasado))?$/.test(
    normalized,
  );
}

/**
 * Extrae sólo pedidos administrativos explícitos sobre un paciente. La
 * autorización del remitente sigue a cargo del webhook y de la allowlist.
 * Conserva el nombre original para mostrarlo y normaliza sólo para validar.
 */
export function extractOwnerPatientQuery(body: string): string | null {
  if (body.length > 500) return null;
  const phrase = patientRequestPhrase(body);
  if (!phrase) return null;

  const patterns = [
    /^(?:(?:los|la|el)\s+)?(?:datos|ficha|info|informaci[oó]n|tel[eé]fono|celular|contacto)\s+(?:(?:de|del)\s+)?(?:(?:la|el)\s+)?(?:paciente\s+)?(.+)$/iu,
    /^(?:paciente|buscar|busc[aá]|busc[aá]me)\s+(?:(?:a|al)\s+)?(?:(?:la|el)\s+)?(?:paciente\s+)?(.+)$/iu,
    /^qu[eé]\s+turnos?\s+tiene\s+(?:(?:la|el)\s+)?(?:paciente\s+)?(.+)$/iu,
    /^(?:cu[aá]ndo|qu[eé]\s+d[ií]a)\s+(?:viene|tiene\s+turno)\s+(?:(?:la|el)\s+)?(?:paciente\s+)?(.+)$/iu,
    /^(?:cu[aá]ndo|qu[eé]\s+d[ií]a)\s+(?:se\s+atiende|atienden?\s+(?:a|al))\s+(?:(?:la|el)\s+)?(?:paciente\s+)?(.+)$/iu,
    /^(?:(?:cu[aá]l|cu[aá]ndo)\s+es\s+)?(?:el\s+)?(?:pr[oó]ximo\s+)?turno\s+(?:de|del)\s+(?:(?:la|el)\s+)?(?:paciente\s+)?(.+)$/iu,
  ];
  for (const pattern of patterns) {
    const query = phrase.match(pattern)?.[1]?.trim();
    if (query && validPatientQuery(query)) return query;
  }
  return null;
}
