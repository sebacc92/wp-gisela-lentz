import type { SupabaseClient } from "npm:@supabase/supabase-js@2.112.2";
import {
  matchCalendarPatientContact,
  matchCalendarPatientService,
  parseCalendarPatientTitle,
} from "../_shared/calendar-patient-title.ts";

interface ImportBlock {
  google_event_id: string;
  summary: string | null;
  starts_at: string;
  ends_at: string;
}

interface ImportContact {
  id: string;
  name: string;
  phone_e164: string | null;
  alternate_phone_e164: string | null;
}

interface ImportService {
  id: string;
  name: string;
  requires_orthodontic_intake: boolean;
}

export interface PatientImportSummary {
  appointmentsImported: number;
  patientImportsNeedReview: number;
  patientImportsFailed: number;
}

export function emptyPatientImportSummary(): PatientImportSummary {
  return {
    appointmentsImported: 0,
    patientImportsNeedReview: 0,
    patientImportsFailed: 0,
  };
}

const PAGE_SIZE = 200;
const MAX_PAGES = 25;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Import only after a complete inbound observation has committed. No call in
 * this module sends messages or mutates Google: the original event stays the
 * calendar source, and SQL binds a real appointment to it atomically. */
export async function importCalendarPatientAppointments(input: {
  client: SupabaseClient;
  calendarId: string;
  generation: number;
  automationEpoch: string;
  coverageStartsAt: string;
  coverageEndsAt: string;
  now: Date;
}): Promise<PatientImportSummary> {
  const summary = emptyPatientImportSummary();
  const { client } = input;
  const blocks: ImportBlock[] = [];
  let afterEventId: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    let query = client
      .from("google_calendar_external_events")
      .select("google_event_id,summary,starts_at,ends_at")
      .eq("google_calendar_id", input.calendarId)
      .eq("connection_generation", input.generation)
      .eq("status", "active")
      .eq("kind", "block")
      .eq("all_day", false)
      .eq("recurring", false)
      .gte(
        "starts_at",
        new Date(
          Math.max(input.now.getTime(), Date.parse(input.coverageStartsAt)),
        ).toISOString(),
      )
      .lte("ends_at", input.coverageEndsAt)
      .order("google_event_id")
      .limit(PAGE_SIZE);
    if (afterEventId) query = query.gt("google_event_id", afterEventId);
    const { data, error } = await query;
    if (error || !Array.isArray(data))
      throw new Error("CALENDAR_PATIENT_BLOCKS_UNAVAILABLE");
    blocks.push(...(data as ImportBlock[]));
    if (data.length < PAGE_SIZE) break;
    afterEventId = data.at(-1)?.google_event_id;
    if (!afterEventId || page === MAX_PAGES - 1) {
      throw new Error("CALENDAR_PATIENT_BLOCKS_INCOMPLETE");
    }
  }
  const candidates = blocks
    .map((block) => ({
      block,
      hints: parseCalendarPatientTitle(block.summary),
    }))
    .filter(({ hints }) => hints.isPatientCandidate);
  if (!candidates.length) return summary;

  // Read all contacts before matching. A truncated name list must never make
  // an ambiguous patient look unique or cause a duplicate new patient.
  const contacts: ImportContact[] = [];
  let afterContactId: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    let query = client
      .from("contacts")
      .select("id,name,phone_e164,alternate_phone_e164")
      .order("id")
      .limit(PAGE_SIZE);
    if (afterContactId) query = query.gt("id", afterContactId);
    const { data, error } = await query;
    if (error || !Array.isArray(data))
      throw new Error("CALENDAR_PATIENT_CONTACTS_UNAVAILABLE");
    contacts.push(...(data as ImportContact[]));
    if (data.length < PAGE_SIZE) break;
    afterContactId = data.at(-1)?.id;
    if (!afterContactId || page === MAX_PAGES - 1) {
      throw new Error("CALENDAR_PATIENT_CONTACTS_INCOMPLETE");
    }
  }
  const [professionals, services] = await Promise.all([
    client.from("professionals").select("id").eq("active", true).limit(2),
    client
      .from("services")
      .select("id,name,requires_orthodontic_intake")
      .eq("active", true)
      .limit(100),
  ]);
  if (
    professionals.error ||
    services.error ||
    !professionals.data ||
    !services.data ||
    services.data.length >= 100
  ) {
    throw new Error("CALENDAR_PATIENT_OPTIONS_UNAVAILABLE");
  }
  for (const { block, hints } of candidates) {
    const matching = matchCalendarPatientContact(hints, contacts);
    const serviceId = matchCalendarPatientService(hints, services.data);
    const service = (services.data as ImportService[]).find(
      (item) => item.id === serviceId,
    );
    // El título sin teléfono igual se importa: la ficha se identifica por el
    // nombre completo y el RPC rechaza crear una si ya existe otra igual.
    if (
      hints.uncertainties.length ||
      !hints.name ||
      !hints.coverage ||
      hints.isExistingPatient === null ||
      professionals.data.length !== 1 ||
      !service ||
      (service.requires_orthodontic_intake && !hints.orthodonticVisitType) ||
      matching.reason === "ambiguous" ||
      matching.reason === "phone_name_conflict"
    ) {
      summary.patientImportsNeedReview += 1;
      continue;
    }
    const { data, error } = await Promise.resolve()
      .then(() =>
        client.rpc("import_google_calendar_patient_appointment", {
          p_google_event_id: block.google_event_id,
          p_contact_id: matching.contactId,
          p_patient_name: hints.name,
          p_patient_phone: hints.phoneE164,
          p_coverage: hints.coverage,
          p_is_existing_patient: hints.isExistingPatient,
          p_professional_id: professionals.data[0].id,
          p_service_id: service.id,
          p_starts_at: block.starts_at,
          p_internal_note: block.summary,
          p_orthodontic_visit_type: service.requires_orthodontic_intake
            ? hints.orthodonticVisitType
            : null,
          p_expected_generation: input.generation,
          p_expected_google_calendar_id: input.calendarId,
          p_automation_epoch: input.automationEpoch,
          p_expected_summary: block.summary,
          p_expected_ends_at: block.ends_at,
        }),
      )
      .catch(() => ({
        data: null,
        error: { message: "IMPORT_TRANSPORT_FAILED" },
      }));
    if (error) {
      // Domain rejections leave the whole block/patient transaction untouched.
      // Unexpected errors are separately reported and retried on the next pull.
      if (
        /SLOT_UNAVAILABLE|COVERAGE_REQUIRED|CONTACT_IDENTITY_CONFLICT|PATIENT_|CALENDAR_BLOCK_|ORTHODONTIC_|SERVICE_NOT_AVAILABLE/.test(
          error.message,
        )
      ) {
        summary.patientImportsNeedReview += 1;
      } else {
        summary.patientImportsFailed += 1;
      }
      continue;
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (
      !row ||
      !UUID.test(row.appointment_id) ||
      typeof row.created !== "boolean"
    ) {
      summary.patientImportsFailed += 1;
    } else if (row.created) {
      summary.appointmentsImported += 1;
    }
  }
  return summary;
}
