/**
 * Tipos compartidos de Configuración.
 *
 * Viven fuera de la pantalla para que cada pestaña sea un componente propio y
 * no haya que arrastrar el archivo entero para tocar una sección.
 */

export interface ServiceRow {
  id: string;
  name: string;
  description: string | null;
  duration_minutes: number;
  active: boolean;
  sort_order: number;
}

export interface RuleRow {
  id: string;
  weekday: number;
  start_time: string;
  end_time: string;
  slot_minutes: number;
  active: boolean;
}

export interface BlockRow {
  id: string;
  date: string;
  start_time: string | null;
  end_time: string | null;
  reason: string | null;
}

export interface ProfileRow {
  id: string;
  full_name: string;
  role: "ADMIN" | "OPERADOR";
  active: boolean;
}

export interface SelectableGoogleCalendar {
  id: string;
  name: string;
  primary: boolean;
  timeZone: string;
}

export type SettingsTab =
  | "booking"
  | "office"
  | "hours"
  | "appointments"
  | "google"
  | "reminders"
  | "automation"
  | "whatsapp"
  | "users"
  | "audit";

export interface SettingsTabOption {
  key: SettingsTab;
  label: string;
}

/** Estado compartido por todas las pestañas. */
export interface SettingsState {
  clinicName: string;
  subtitle: string;
  phone: string;
  email: string;
  address: string;
  logoUrl: string;
  timezone: string;
  defaultDuration: number;
  bufferMinutes: number;
  minimumNoticeMinutes: number;
  reminder24h: boolean;
  reminderDayBeforeTime: string;
  reminder2h: boolean;
  reminder2hMinutes: number;
  automationWelcomeMessage: string;
  depositEnabled: boolean;
  depositAmountArs: number;
  depositAlias: string;
  depositHolder: string;
  bookingHoldMinutes: number;
  iomaDurationMinutes: number;
  privateDurationMinutes: number;
  depositRequestMessageTemplate: string;
  depositProofReceivedMessageTemplate: string;
  depositConfirmedMessageTemplate: string;
  bookingHoldExpiredMessageTemplate: string;
  outOfHoursEnabled: boolean;
  outOfHoursMessage: string;
  outOfHoursCooldownMinutes: number;
  urgentMessage: string;
  generalInfoMessage: string;
  aiEnabled: boolean;
  aiMediaEnabled: boolean;
  aiModel: string;
  whatsappStatus: "incomplete" | "connected" | "error";
  whatsappPhone: string;
  whatsappName: string;
  lastHealthCheck: string;
  whatsappQuality: "GREEN" | "YELLOW" | "RED" | "UNKNOWN";
  sendingPaused: boolean;
  sendingPauseReason: string;
  testMode: boolean;
  testAllowedNumberCount: number;
  professionalId: string;
  services: ServiceRow[];
  rules: RuleRow[];
  blocks: BlockRow[];
  users: ProfileRow[];
  isAdmin: boolean;
  loading: boolean;
  loadError: boolean;
}
