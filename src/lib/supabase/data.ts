import { orthodonticVisitType } from "~/lib/orthodontics";
import type { SupabaseClient } from "@supabase/supabase-js";
import { BUSINESS_CONFIG } from "~/config/business";
import {
  appointmentDisplayStatus,
  effectiveDepositStatus,
  type AppointmentStatus,
} from "~/lib/booking";
import type {
  AppointmentSlot,
  AppointmentSummary,
  BookingDurationSettings,
  Conversation,
  DepositStatus,
  PatientCoverage,
  OrthodonticVisitType,
  ProfessionalOption,
  QuickReply,
  ServiceOption,
  WhatsAppConsentStatus,
} from "../inbox-types";
import {
  formatInboxMessageTime,
  inboxMessagePageFromRows,
  INBOX_MESSAGE_PAGE_SIZE,
  type InboxMessageRow,
} from "./inbox-messages";

interface ConversationRow {
  id: string;
  contact_id: string;
  status: "open" | "closed";
  automation_mode: "auto" | "manual";
  needs_human: boolean;
  priority: boolean;
  unread_count: number;
  last_message_at: string;
  last_inbound_message_at: string | null;
  current_flow: string | null;
  contacts: ContactRow | ContactRow[] | null;
  messages: InboxMessageRow[] | null;
}

interface ContactRow {
  id: string;
  name: string;
  phone_e164: string | null;
  whatsapp_consent_status: WhatsAppConsentStatus;
  whatsapp_opt_in_at: string | null;
  whatsapp_opt_out_at: string | null;
  coverage: PatientCoverage | null;
  is_existing_patient: boolean | null;
}

interface AppointmentRow {
  id: string;
  contact_id: string;
  professional_id: string;
  service_id: string | null;
  starts_at: string;
  ends_at: string;
  status: AppointmentStatus;
  google_calendar_imported: boolean;
  coverage: PatientCoverage | null;
  duration_minutes: number;
  deposit_status: DepositStatus;
  orthodontic_visit_type: OrthodonticVisitType | null;
  hold_expires_at: string | null;
  deposit_proof_message_id: string | null;
  deposit_confirmation_actor: "automatic_system" | null;
  deposit_confirmation_policy_version: string | null;
  professionals: { name: string } | Array<{ name: string }> | null;
  services: { name: string } | Array<{ name: string }> | null;
}

export interface AppointmentListItem {
  id: string;
  contactId: string;
  professionalId: string;
  startsAt: string;
  endsAt: string;
  status: AppointmentRow["status"];
  source: "whatsapp" | "manual";
  googleCalendarImported: boolean;
  internalNote: string | null;
  contactName: string;
  contactPhone: string;
  contactCoverage: PatientCoverage | null;
  professionalName: string;
  serviceId: string | null;
  serviceName: string;
  coverage: PatientCoverage | null;
  durationMinutes: number;
  depositStatus: DepositStatus;
  orthodonticVisitType: OrthodonticVisitType | null;
  holdExpiresAt: string | null;
  depositProofMessageId: string | null;
  depositConfirmationActor: "automatic_system" | null;
  depositConfirmationPolicyVersion: string | null;
}

const avatarTones: Conversation["avatarTone"][] = [
  "teal",
  "blue",
  "violet",
  "amber",
  "rose",
];

function single<T>(value: T | T[] | null): T | null {
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toLocaleUpperCase("es-AR") ?? "")
    .join("");
}

function avatarTone(id: string): Conversation["avatarTone"] {
  const hash = Array.from(id).reduce(
    (sum, char) => sum + char.charCodeAt(0),
    0,
  );
  return avatarTones[hash % avatarTones.length];
}

function mapAppointment(row: AppointmentRow): AppointmentSummary {
  const professional = single(row.professionals)?.name ?? "Gisela Lentz";
  const service = single(row.services)?.name ?? "Consulta";
  const date = new Date(row.starts_at);
  const dateLabel = new Intl.DateTimeFormat("es-AR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: BUSINESS_CONFIG.timezone,
  }).format(date);
  const normalizedDateLabel = `${dateLabel.charAt(0).toLocaleUpperCase("es-AR")}${dateLabel.slice(1)}`;
  const depositStatus = effectiveDepositStatus(
    row.status,
    row.deposit_status,
    row.hold_expires_at,
  );
  const status = appointmentDisplayStatus(row.status, depositStatus);

  return {
    id: row.id,
    dateLabel: normalizedDateLabel,
    time: new Intl.DateTimeFormat("es-AR", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: BUSINESS_CONFIG.timezone,
    }).format(date),
    professional,
    service,
    serviceId: row.service_id ?? undefined,
    professionalId: row.professional_id,
    startsAt: row.starts_at,
    googleCalendarImported: row.google_calendar_imported === true,
    status,
    coverage: row.coverage ?? undefined,
    durationMinutes: row.duration_minutes,
    depositStatus,
    orthodonticVisitType:
      orthodonticVisitType(row.orthodontic_visit_type) ?? undefined,
    holdExpiresAt: row.hold_expires_at ?? undefined,
    depositProofMessageId: row.deposit_proof_message_id ?? undefined,
    depositConfirmationActor: row.deposit_confirmation_actor ?? undefined,
    depositConfirmationPolicyVersion:
      row.deposit_confirmation_policy_version ?? undefined,
  };
}

export async function loadInboxData(client: SupabaseClient): Promise<{
  conversations: Conversation[];
  quickReplies: QuickReply[];
}> {
  const { data: conversationData, error: conversationsError } = await client
    .from("conversations")
    .select(
      "id, contact_id, status, automation_mode, needs_human, priority, unread_count, last_message_at, last_inbound_message_at, current_flow, contacts!conversations_contact_id_fkey(id,name,phone_e164,whatsapp_consent_status,whatsapp_opt_in_at,whatsapp_opt_out_at,coverage,is_existing_patient), messages!messages_conversation_id_fkey(id,conversation_id,body,direction,type,status,created_at,whatsapp_ingest_sequence,metadata)",
    )
    .is("messages.original_whatsapp_message_id", null)
    .order("last_message_at", { ascending: false })
    .order("created_at", { referencedTable: "messages", ascending: false })
    .order("whatsapp_ingest_sequence", {
      referencedTable: "messages",
      ascending: false,
    })
    .limit(INBOX_MESSAGE_PAGE_SIZE + 1, { referencedTable: "messages" });

  if (conversationsError) throw conversationsError;

  const conversationRows = (conversationData ??
    []) as unknown as ConversationRow[];
  const contactIds = conversationRows.map((row) => row.contact_id);

  const [appointmentsResult, quickRepliesResult] = await Promise.all([
    contactIds.length
      ? client
          .from("appointments")
          .select(
            "id,contact_id,professional_id,service_id,starts_at,ends_at,status,google_calendar_imported,coverage,duration_minutes,deposit_status,orthodontic_visit_type,hold_expires_at,deposit_proof_message_id,deposit_confirmation_actor,deposit_confirmation_policy_version,professionals!appointments_professional_id_fkey(name),services!appointments_service_id_fkey(name)",
          )
          .in("contact_id", contactIds)
          .order("starts_at", { ascending: true })
      : Promise.resolve({ data: [], error: null }),
    client
      .from("quick_replies")
      .select("id,shortcut,title,body")
      .eq("enabled", true)
      .order("shortcut"),
  ]);

  if (appointmentsResult.error) throw appointmentsResult.error;
  if (quickRepliesResult.error) throw quickRepliesResult.error;

  const appointmentRows = (appointmentsResult.data ??
    []) as unknown as AppointmentRow[];
  const now = Date.now();

  const conversations = conversationRows.map((row): Conversation => {
    const contact = single(row.contacts) ?? {
      id: row.contact_id,
      name: "Contacto",
      phone_e164: "",
      whatsapp_consent_status: "unknown" as const,
      whatsapp_opt_in_at: null,
      whatsapp_opt_out_at: null,
      coverage: null,
      is_existing_patient: null,
    };
    const messagePage = inboxMessagePageFromRows(row.messages ?? []);
    const messages = messagePage.messages;
    const contactAppointments = appointmentRows
      .filter((appointment) => appointment.contact_id === row.contact_id)
      .map(mapAppointment);
    const upcomingAppointment = contactAppointments.find(
      (appointment) =>
        appointment.startsAt &&
        new Date(appointment.startsAt).getTime() >= now &&
        appointment.status !== "Cancelado",
    );
    const previousAppointments = contactAppointments.filter(
      (appointment) => appointment.id !== upcomingAppointment?.id,
    );
    const lastMessage = messages[messages.length - 1];

    return {
      id: row.id,
      contactId: contact.id,
      name: contact.name,
      phone: contact.phone_e164 ?? "Identidad privada de WhatsApp",
      initials: initials(contact.name),
      avatarTone: avatarTone(contact.id),
      lastMessage: lastMessage?.body || "Sin mensajes todavía",
      time: formatInboxMessageTime(
        lastMessage?.createdAt ?? row.last_message_at,
      ),
      unreadCount: row.unread_count,
      needsHuman: row.needs_human,
      priority: row.priority,
      automationMode: row.automation_mode,
      status: row.status,
      messages,
      hasOlderMessages: messagePage.hasOlderMessages,
      upcomingAppointment,
      previousAppointments,
      lastInboundMessageAt: row.last_inbound_message_at ?? undefined,
      whatsappConsentStatus: contact.whatsapp_consent_status,
      whatsappOptInAt: contact.whatsapp_opt_in_at ?? undefined,
      whatsappOptOutAt: contact.whatsapp_opt_out_at ?? undefined,
      coverage: contact.coverage ?? undefined,
      isExistingPatient: contact.is_existing_patient ?? undefined,
      currentFlow: row.current_flow ?? undefined,
    };
  });

  return {
    conversations,
    quickReplies: (quickRepliesResult.data ?? []) as QuickReply[],
  };
}

export async function loadProfessionals(
  client: SupabaseClient,
): Promise<ProfessionalOption[]> {
  const { data, error } = await client
    .from("professionals")
    .select("id,name,appointment_duration_minutes")
    .eq("active", true)
    .order("name");

  if (error) throw error;
  return (data ?? []).map((row) => ({
    id: row.id as string,
    name: row.name as string,
    appointmentDurationMinutes: row.appointment_duration_minutes as number,
  }));
}

export async function loadServices(
  client: SupabaseClient,
  includeInactive = false,
): Promise<ServiceOption[]> {
  let query = client
    .from("services")
    .select(
      "id,name,description,duration_minutes,requires_orthodontic_intake,active,sort_order",
    )
    .order("sort_order")
    .order("name");
  if (!includeInactive) query = query.eq("active", true);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []).map((row) => ({
    id: row.id as string,
    name: row.name as string,
    description: (row.description as string | null) ?? undefined,
    durationMinutes: row.duration_minutes as number,
    requiresOrthodonticIntake: row.requires_orthodontic_intake === true,
  }));
}

export async function loadBookingDurationSettings(
  client: SupabaseClient,
): Promise<BookingDurationSettings> {
  const { data, error } = await client
    .from("app_settings")
    .select("ioma_duration_minutes,private_duration_minutes")
    .eq("id", true)
    .single();
  if (error) throw error;
  return {
    iomaMinutes: Number(data.ioma_duration_minutes),
    privateMinutes: Number(data.private_duration_minutes),
  };
}

export interface DepositSettings {
  amountArs: number | null;
  alias: string | null;
  holder: string | null;
}

/**
 * Datos de la seña para completar respuestas rápidas. Es configuración, no
 * dato del paciente: si falta alguno, la respuesta deja el hueco a la vista.
 */
export async function loadDepositSettings(
  client: SupabaseClient,
): Promise<DepositSettings> {
  const { data, error } = await client
    .from("app_settings")
    .select("deposit_enabled,deposit_amount_ars,deposit_alias,deposit_holder")
    .eq("id", true)
    .single();
  if (error) throw error;

  const enabled = data.deposit_enabled === true;
  const amount = Number(data.deposit_amount_ars);
  return {
    amountArs: enabled && Number.isFinite(amount) && amount > 0 ? amount : null,
    alias: enabled ? ((data.deposit_alias as string | null) ?? null) : null,
    holder: enabled ? ((data.deposit_holder as string | null) ?? null) : null,
  };
}

export async function loadAppointments(
  client: SupabaseClient,
  fromIso: string,
  toIso?: string,
): Promise<AppointmentListItem[]> {
  let query = client
    .from("appointments")
    .select(
      "id,contact_id,professional_id,service_id,starts_at,ends_at,status,source,google_calendar_imported,internal_note,coverage,duration_minutes,deposit_status,orthodontic_visit_type,hold_expires_at,deposit_proof_message_id,deposit_confirmation_actor,deposit_confirmation_policy_version,contacts!appointments_contact_id_fkey(name,phone_e164,coverage),professionals!appointments_professional_id_fkey(name),services!appointments_service_id_fkey(name)",
    )
    .gte("starts_at", fromIso);
  if (toIso) query = query.lt("starts_at", toIso);
  const { data, error } = await query.order("starts_at");

  if (error) throw error;

  return (data ?? []).map((raw) => {
    const row = raw as unknown as {
      id: string;
      contact_id: string;
      professional_id: string;
      service_id: string | null;
      starts_at: string;
      ends_at: string;
      status: AppointmentListItem["status"];
      source: AppointmentListItem["source"];
      google_calendar_imported: boolean;
      internal_note: string | null;
      coverage: PatientCoverage | null;
      duration_minutes: number;
      deposit_status: DepositStatus;
      orthodontic_visit_type: OrthodonticVisitType | null;
      hold_expires_at: string | null;
      deposit_proof_message_id: string | null;
      deposit_confirmation_actor: "automatic_system" | null;
      deposit_confirmation_policy_version: string | null;
      contacts:
        | {
            name: string;
            phone_e164: string | null;
            coverage: PatientCoverage | null;
          }
        | Array<{
            name: string;
            phone_e164: string | null;
            coverage: PatientCoverage | null;
          }>
        | null;
      professionals: { name: string } | Array<{ name: string }> | null;
      services: { name: string } | Array<{ name: string }> | null;
    };
    const contact = single(row.contacts);
    const professional = single(row.professionals);
    const service = single(row.services);
    const depositStatus = effectiveDepositStatus(
      row.status,
      row.deposit_status,
      row.hold_expires_at,
    );
    return {
      id: row.id,
      contactId: row.contact_id,
      professionalId: row.professional_id,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      status: row.status,
      source: row.source,
      googleCalendarImported: row.google_calendar_imported === true,
      internalNote: row.internal_note,
      contactName: contact?.name ?? "Paciente",
      contactPhone: contact?.phone_e164 ?? "",
      contactCoverage: contact?.coverage ?? null,
      professionalName: professional?.name ?? "Gisela Lentz",
      serviceId: row.service_id,
      serviceName: service?.name ?? "Consulta",
      coverage: row.coverage,
      durationMinutes: row.duration_minutes,
      depositStatus,
      orthodonticVisitType: orthodonticVisitType(row.orthodontic_visit_type),
      holdExpiresAt: row.hold_expires_at,
      depositProofMessageId: row.deposit_proof_message_id,
      depositConfirmationActor: row.deposit_confirmation_actor,
      depositConfirmationPolicyVersion: row.deposit_confirmation_policy_version,
    };
  });
}

export async function loadAvailableSlots(
  client: SupabaseClient,
  professionalId: string,
  date: string,
  coverage?: PatientCoverage,
): Promise<AppointmentSlot[]> {
  if (!professionalId || !date || !coverage) return [];

  const { data, error } = await client.rpc("get_available_slots_for_coverage", {
    p_professional_id: professionalId,
    p_coverage: coverage,
    p_date: date,
    p_timezone: BUSINESS_CONFIG.timezone,
    p_limit: 40,
  });

  if (error) throw error;

  return (data ?? []).map(
    (row: { starts_at: string; ends_at: string }): AppointmentSlot => ({
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      label: new Intl.DateTimeFormat("es-AR", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: BUSINESS_CONFIG.timezone,
      }).format(new Date(row.starts_at)),
    }),
  );
}

export interface CalendarBlock {
  googleEventId: string;
  summary: string | null;
  startsAt: string;
  endsAt: string;
  allDay: boolean;
}

export interface CalendarUnsupportedEvent {
  googleEventId: string;
  summary: string | null;
  reason:
    | "ALL_DAY"
    | "RECURRING"
    | "MISSING_RANGE"
    | "INVALID_RANGE"
    | "AMBIGUOUS_BUSY_STATE";
}

/** Bloqueos importados desde Google que ocupan la agenda del día mostrado. */
export async function loadCalendarBlocks(
  client: SupabaseClient,
  fromIso: string,
  toIso?: string,
): Promise<CalendarBlock[]> {
  let query = client
    .from("google_calendar_external_events")
    .select("google_event_id,summary,starts_at,ends_at,all_day")
    .eq("kind", "block")
    .eq("status", "active");
  if (toIso) query = query.lt("starts_at", toIso);
  const { data, error } = await query
    .gt("ends_at", fromIso)
    .order("starts_at")
    .limit(200);
  if (error) throw error;

  return (data ?? []).map((raw) => {
    const row = raw as unknown as {
      google_event_id: string;
      summary: string | null;
      starts_at: string;
      ends_at: string;
      all_day: boolean;
    };
    return {
      googleEventId: row.google_event_id,
      summary: row.summary,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      allDay: row.all_day,
    };
  });
}

export async function loadCalendarUnsupportedEvents(
  client: SupabaseClient,
): Promise<CalendarUnsupportedEvent[]> {
  const { data, error } = await client
    .from("google_calendar_external_events")
    .select("google_event_id,summary,unsupported_reason")
    .eq("kind", "unsupported")
    .eq("status", "active")
    .order("imported_at", { ascending: false })
    .limit(50);
  if (error) throw error;

  return (data ?? []).map((raw) => {
    const row = raw as unknown as {
      google_event_id: string;
      summary: string | null;
      unsupported_reason: CalendarUnsupportedEvent["reason"];
    };
    return {
      googleEventId: row.google_event_id,
      summary: row.summary,
      reason: row.unsupported_reason,
    };
  });
}

export interface CalendarConflict {
  id: string;
  appointmentId: string;
  imported: boolean;
  kind: "reschedule_requested" | "cancellation_requested" | "metadata_changed";
  proposedStartsAt: string | null;
  proposedEndsAt: string | null;
  observedStartsAt: string | null;
  observedEndsAt: string | null;
  detectedAt: string;
  contactName: string;
}

/** Cambios hechos en Google sobre turnos reales, esperando decisión ADMIN. */
export async function loadCalendarConflicts(
  client: SupabaseClient,
): Promise<CalendarConflict[]> {
  const { data, error } = await client
    .from("google_calendar_sync_conflicts")
    .select(
      "id,appointment_id,kind,proposed_starts_at,proposed_ends_at,observed_starts_at,observed_ends_at,detected_at,appointments!google_calendar_sync_conflicts_appointment_id_fkey(google_calendar_imported,contacts!appointments_contact_id_fkey(name))",
    )
    .eq("status", "pending")
    .order("detected_at", { ascending: false })
    .limit(50);
  if (error) throw error;

  return (data ?? []).map((raw) => {
    const row = raw as unknown as {
      id: string;
      appointment_id: string;
      kind: CalendarConflict["kind"];
      proposed_starts_at: string | null;
      proposed_ends_at: string | null;
      observed_starts_at: string | null;
      observed_ends_at: string | null;
      detected_at: string;
      appointments:
        | {
            google_calendar_imported: boolean;
            contacts: { name: string } | Array<{ name: string }> | null;
          }
        | Array<{
            google_calendar_imported: boolean;
            contacts: { name: string } | Array<{ name: string }> | null;
          }>
        | null;
    };
    const appointment = Array.isArray(row.appointments)
      ? row.appointments[0]
      : row.appointments;
    const contact = Array.isArray(appointment?.contacts)
      ? appointment?.contacts[0]
      : appointment?.contacts;
    return {
      id: row.id,
      appointmentId: row.appointment_id,
      // Missing ownership information must not offer a Google restore action.
      imported: appointment?.google_calendar_imported !== false,
      kind: row.kind,
      proposedStartsAt: row.proposed_starts_at,
      proposedEndsAt: row.proposed_ends_at,
      observedStartsAt: row.observed_starts_at,
      observedEndsAt: row.observed_ends_at,
      detectedAt: row.detected_at,
      contactName: contact?.name ?? "Turno",
    };
  });
}

export interface DepositProofReview {
  id: string;
  appointmentId: string;
  proofMessageId: string;
  status: "pending" | "confirmed" | "rejected" | "more_requested";
  acknowledgedAt: string | null;
}

/** Comprobantes esperando una decisión humana para los turnos visibles. */
export async function loadDepositProofReviews(
  client: SupabaseClient,
  appointmentIds: string[],
): Promise<DepositProofReview[]> {
  if (appointmentIds.length === 0) return [];
  const { data, error } = await client
    .from("deposit_proof_reviews")
    .select("id,appointment_id,proof_message_id,status,acknowledged_at")
    .in("appointment_id", appointmentIds.slice(0, 200))
    .order("created_at", { ascending: false });
  if (error) throw error;

  return (data ?? []).map((raw) => {
    const row = raw as unknown as {
      id: string;
      appointment_id: string;
      proof_message_id: string;
      status: DepositProofReview["status"];
      acknowledged_at: string | null;
    };
    return {
      id: row.id,
      appointmentId: row.appointment_id,
      proofMessageId: row.proof_message_id,
      status: row.status,
      acknowledgedAt: row.acknowledged_at,
    };
  });
}
