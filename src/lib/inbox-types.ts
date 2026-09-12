export type MessageStatus =
  | "pending"
  | "sent"
  | "delivered"
  | "read"
  | "failed";

export type WhatsAppConsentStatus = "unknown" | "opted_in" | "opted_out";
export type PatientCoverage = "ioma" | "particular";
export type OrthodonticVisitType = "first_visit" | "in_treatment";
export type DepositStatus =
  | "not_required"
  | "pending"
  | "proof_received"
  | "confirmed"
  | "expired";

export interface MessageLocation {
  latitude: number;
  longitude: number;
  name: string;
  address: string;
  mapUrl: string;
}

export interface Message {
  id: string;
  body: string;
  direction: "inbound" | "outbound" | "system";
  time: string;
  status?: MessageStatus;
  label?: string;
  createdAt?: string;
  ingestSequence?: number;
  type?:
    | "text"
    | "template"
    | "interactive"
    | "image"
    | "document"
    | "audio"
    | "location"
    | "system";
  filename?: string;
  mimeType?: string;
  hasMedia?: boolean;
  depositProofLate?: boolean;
  location?: MessageLocation;
}

export interface AppointmentSummary {
  id: string;
  dateLabel: string;
  time: string;
  professional: string;
  /** Nombre de quien se atiende cuando el turno lo gestiona este contacto. */
  patientName?: string;
  status:
    | "Esperando seña"
    | "Comprobante recibido"
    | "Confirmado"
    | "Atendido"
    | "Cancelado"
    | "No asistió";
  startsAt?: string;
  googleCalendarImported?: boolean;
  professionalId?: string;
  service?: string;
  serviceId?: string;
  coverage?: PatientCoverage;
  durationMinutes?: number;
  depositStatus?: DepositStatus;
  orthodonticVisitType?: OrthodonticVisitType;
  holdExpiresAt?: string;
  depositProofMessageId?: string;
  depositConfirmationActor?: "automatic_system";
  depositConfirmationPolicyVersion?: string;
}

export interface Conversation {
  id: string;
  contactId: string;
  name: string;
  phone: string;
  initials: string;
  avatarTone: "teal" | "blue" | "violet" | "amber" | "rose";
  lastMessage: string;
  time: string;
  unreadCount: number;
  needsHuman: boolean;
  priority: boolean;
  automationMode: "auto" | "manual";
  status: "open" | "closed";
  messages: Message[];
  hasOlderMessages: boolean;
  upcomingAppointment?: AppointmentSummary;
  previousAppointments: AppointmentSummary[];
  lastInboundMessageAt?: string;
  whatsappConsentStatus?: WhatsAppConsentStatus;
  whatsappOptInAt?: string;
  whatsappOptOutAt?: string;
  coverage?: PatientCoverage;
  isExistingPatient?: boolean;
  currentFlow?: string;
}

export interface QuickReply {
  id?: string;
  shortcut: string;
  title: string;
  body: string;
}

export interface ProfessionalOption {
  id: string;
  name: string;
  appointmentDurationMinutes: number;
}

export interface BookingDurationSettings {
  iomaMinutes: number;
  privateMinutes: number;
}

export interface ServiceOption {
  id: string;
  name: string;
  description?: string;
  durationMinutes: number;
  requiresOrthodonticIntake: boolean;
}

export interface AppointmentSlot {
  startsAt: string;
  endsAt: string;
  label: string;
}
