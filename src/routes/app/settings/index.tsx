import {
  $,
  component$,
  useContext,
  useSignal,
  useStore,
  useVisibleTask$,
} from "@qwik.dev/core";
import { Link, type DocumentHead, useLocation } from "@qwik.dev/router";
import { AppNavigation } from "~/components/app/AppNavigation";
import { BOT_AUTOMATION_CONTEXT } from "~/components/app/BotAutomationContext";
import { ManualHelpLink } from "~/components/app/ManualHelpLink";
import { WhatsAppEmbeddedSignup } from "~/components/settings/WhatsAppEmbeddedSignup";
import { Icon } from "~/components/ui/Icon";
import { BUSINESS_CONFIG, getPageTitle } from "~/config/business";
import {
  describeCalendarSync,
  parseCalendarSyncOutcome,
  parseCalendarSyncSummary,
} from "~/lib/calendar-sync-summary";
import {
  parseCalendarImportPreview,
  sameCalendarImportPreview,
  type CalendarImportPreview,
} from "~/lib/google-calendar-import-preview";
import {
  canRunManualGoogleCalendarSync,
  googleCalendarSyncStatus,
  type GoogleCalendarSyncStatus,
} from "~/lib/google-calendar-ui-state";
import { getSupabaseClient } from "~/lib/supabase/client";
import {
  loadCalendarConflicts,
  type CalendarConflict,
} from "~/lib/supabase/data";

type SettingsTab =
  | "booking"
  | "office"
  | "hours"
  | "appointments"
  | "google"
  | "reminders"
  | "automation"
  | "whatsapp"
  | "users";

interface SettingsTabOption {
  key: SettingsTab;
  label: string;
}

const settingsTabAliases: Record<string, SettingsTab> = {
  booking: "booking",
  bookings: "booking",
  reservations: "booking",
  reservas: "booking",
  deposits: "booking",
  senas: "booking",
  office: "office",
  clinic: "office",
  consultorio: "office",
  hours: "hours",
  schedule: "hours",
  horarios: "hours",
  appointments: "appointments",
  services: "appointments",
  turnos: "appointments",
  google: "google",
  calendar: "google",
  calendario: "google",
  reminders: "reminders",
  reminder: "reminders",
  recordatorios: "reminders",
  automation: "automation",
  messages: "automation",
  mensajes: "automation",
  whatsapp: "whatsapp",
  users: "users",
  access: "users",
  accesos: "users",
  usuarios: "users",
};

const mainTabs: SettingsTabOption[] = [
  { key: "booking", label: "WhatsApp y reservas" },
  { key: "office", label: "Datos del consultorio" },
  { key: "hours", label: "Días y horarios" },
  { key: "appointments", label: "Turnos y servicios" },
  { key: "reminders", label: "Recordatorios" },
  { key: "google", label: "Google Calendar" },
];

const moreTabs: SettingsTabOption[] = [
  { key: "automation", label: "Mensajes automáticos" },
  { key: "whatsapp", label: "Estado de WhatsApp" },
  { key: "users", label: "Personas con acceso" },
];

function settingsTabFromUrl(
  value: string | null,
  hasGoogleResult: boolean,
): SettingsTab {
  if (hasGoogleResult) return "google";
  if (!value) return "booking";
  return (
    settingsTabAliases[value.trim().toLocaleLowerCase("es-AR")] ?? "booking"
  );
}

interface ServiceRow {
  id: string;
  name: string;
  description: string | null;
  duration_minutes: number;
  active: boolean;
  sort_order: number;
}

interface RuleRow {
  id: string;
  weekday: number;
  start_time: string;
  end_time: string;
  slot_minutes: number;
  active: boolean;
}

interface BlockRow {
  id: string;
  date: string;
  start_time: string | null;
  end_time: string | null;
  reason: string | null;
}

interface ProfileRow {
  id: string;
  full_name: string;
  role: "ADMIN" | "OPERADOR";
  active: boolean;
}

interface SelectableGoogleCalendar {
  id: string;
  name: string;
  primary: boolean;
  timeZone: string;
}

const GOOGLE_CALENDAR_SELECTION_REQUIRED_MESSAGE =
  "Google ya autorizó la cuenta. Ahora elegí qué calendario querés sincronizar.";

async function googleCalendarFunctionErrorCode(
  data: unknown,
  error: unknown,
): Promise<string> {
  const codeFrom = (value: unknown): string => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return "";
    const code = (value as Record<string, unknown>).error;
    return typeof code === "string" ? code : "";
  };

  const directCode = codeFrom(data);
  if (directCode) return directCode;
  if (!error || typeof error !== "object" || Array.isArray(error)) return "";

  const context = (error as Record<string, unknown>).context;
  const contextCode = codeFrom(context);
  if (contextCode) return contextCode;
  if (!(context instanceof Response)) return "";

  try {
    return codeFrom(await context.clone().json());
  } catch {
    return "";
  }
}

function describeGoogleCalendarSelectionError(code: string): string {
  switch (code) {
    case "GOOGLE_CALENDAR_TIMEZONE_MISMATCH":
      return "Ese calendario usa otra zona horaria. Elegí uno que coincida con la agenda.";
    case "GOOGLE_CALENDAR_EVENTS_ACCESS_REQUIRED":
      return "Google no otorgó el permiso para administrar eventos. Elegí otra cuenta y aceptá ambos permisos.";
    case "GOOGLE_CALENDAR_DISCONNECT_REQUIRED":
      return "Primero desconectá la cuenta actual y después conectá la cuenta nueva.";
    case "GOOGLE_CALENDAR_OWNER_REQUIRED":
      return "Ese calendario no es propio. Elegí uno del que seas propietaria.";
    case "GOOGLE_CALENDAR_SELECTION_EXPIRED":
    case "GOOGLE_CALENDAR_SELECTION_NOT_PENDING":
    case "GOOGLE_RECONNECT_REQUIRED":
      return "La autorización ya no está vigente. Elegí otra cuenta y volvé a conectarla.";
    default:
      return "No pudimos confirmar el calendario. No cambiamos la sincronización actual.";
  }
}

function parseSelectableGoogleCalendars(
  value: unknown,
): SelectableGoogleCalendar[] {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  const calendars: SelectableGoogleCalendar[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const candidate = entry as Record<string, unknown>;
    const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
    const name =
      typeof candidate.name === "string" ? candidate.name.trim() : "";
    if (!id || !name || seen.has(id)) continue;

    seen.add(id);
    calendars.push({
      id,
      name,
      primary: candidate.primary === true,
      timeZone:
        typeof candidate.timeZone === "string" ? candidate.timeZone.trim() : "",
    });
  }
  return calendars;
}

function formatLastCalendarSync(value: string): string {
  if (!value) return "Todavía no se sincronizó";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Todavía no se sincronizó";
  return new Intl.DateTimeFormat("es-AR", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: BUSINESS_CONFIG.timezone,
  }).format(date);
}

const weekdays = [
  "Domingo",
  "Lunes",
  "Martes",
  "Miércoles",
  "Jueves",
  "Viernes",
  "Sábado",
];

function cleanTime(value: string): string {
  return value.slice(0, 5);
}

function formatSettingsDate(value: string): string {
  return new Intl.DateTimeFormat("es-AR", {
    dateStyle: "long",
    timeZone: "UTC",
  }).format(new Date(`${value}T12:00:00Z`));
}

function normalizedPolicyText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("es-AR");
}

function containsRestrictedAutomationRequest(value: string): boolean {
  return /\b(dni|documento de identidad|pasaporte|cuil|cuit|tarjeta|cuenta bancaria|cbu|numero de cuenta|historia clinica|diagnostico|receta|medicacion|dosis|sintomas?)\b/.test(
    normalizedPolicyText(value),
  );
}

export default component$(() => {
  const botAutomation = useContext(BOT_AUTOMATION_CONTEXT);
  const location = useLocation();
  const googleResult =
    location.url.searchParams.get("google") ??
    location.url.searchParams.get("google_calendar");
  const tab = useSignal<SettingsTab>(
    settingsTabFromUrl(
      location.url.searchParams.get("section"),
      Boolean(googleResult),
    ),
  );
  const notice = useSignal("");
  const newServiceName = useSignal("");
  const newServiceDescription = useSignal("");
  const newRuleWeekday = useSignal(1);
  const newRuleStart = useSignal("09:00");
  const newRuleEnd = useSignal("13:00");
  const newBlockDate = useSignal("");
  const newBlockStart = useSignal("");
  const newBlockEnd = useSignal("");
  const newBlockReason = useSignal("");
  const state = useStore({
    clinicName: BUSINESS_CONFIG.name as string,
    subtitle: BUSINESS_CONFIG.subtitle as string,
    phone: "",
    email: "",
    address: "",
    logoUrl: "",
    timezone: BUSINESS_CONFIG.timezone as string,
    defaultDuration: 30,
    bufferMinutes: 0,
    minimumNoticeMinutes: 120,
    reminder24h: false,
    reminderDayBeforeTime: "21:00",
    reminder2h: false,
    reminder2hMinutes: 120,
    automationWelcomeMessage: "",
    depositEnabled: true,
    depositAmountArs: 0,
    depositAlias: "",
    depositHolder: "",
    bookingHoldMinutes: 60,
    iomaDurationMinutes: 0,
    privateDurationMinutes: 0,
    depositRequestMessageTemplate: "",
    depositProofReceivedMessageTemplate: "",
    depositConfirmedMessageTemplate: "",
    bookingHoldExpiredMessageTemplate: "",
    outOfHoursEnabled: false,
    outOfHoursMessage: "",
    outOfHoursCooldownMinutes: 720,
    urgentMessage: "",
    generalInfoMessage: "",
    aiEnabled: false,
    aiMediaEnabled: false,
    aiModel: "gpt-5.6-luna",
    whatsappStatus: "incomplete" as "incomplete" | "connected" | "error",
    whatsappPhone: "",
    whatsappName: "",
    lastHealthCheck: "",
    whatsappQuality: "UNKNOWN" as "GREEN" | "YELLOW" | "RED" | "UNKNOWN",
    sendingPaused: false,
    sendingPauseReason: "",
    testMode: true,
    testAllowedNumberCount: 0,
    professionalId: "",
    services: [] as ServiceRow[],
    rules: [] as RuleRow[],
    blocks: [] as BlockRow[],
    users: [] as ProfileRow[],
    isAdmin: false,
    loading: true,
    loadError: false,
  });
  const googleCalendar = useStore({
    configured: true,
    connected: false,
    selectionPending: googleResult === "selection_required",
    email: "",
    calendarName: "",
    selectableCalendars: [] as SelectableGoogleCalendar[],
    selectableCalendarsLoaded: false,
    selectableCalendarsError: "",
    selectedCalendarId: "",
    syncStatus: "synced" as GoogleCalendarSyncStatus,
    lastSyncedAt: "",
    lastCheckedAt: "",
    lastSyncError: "",
    inboundSyncState: "",
    firstImportApproved: false,
    pendingCount: 0,
    failedCount: 0,
    blockCount: 0,
    unsupportedCount: 0,
    conflictCount: 0,
    conflicts: [] as CalendarConflict[],
    conflictsError: "",
    preview: null as CalendarImportPreview | null,
    loaded: false,
    loading: false,
    action: "" as
      | ""
      | "connect"
      | "sync"
      | "disconnect"
      | "preview"
      | "approve"
      | "load-calendars"
      | "select-calendar"
      | "cancel-selection",
    resolving: "",
    resolvingAction: "" as "" | "reject" | "apply",
    message:
      googleResult === "selection_required"
        ? GOOGLE_CALENDAR_SELECTION_REQUIRED_MESSAGE
        : googleResult === "connected"
          ? "Google Calendar quedó conectado. Estamos comprobando que todo esté al día."
          : googleResult === "denied" || googleResult === "cancelled"
            ? "No se completó la conexión. Podés intentarlo nuevamente cuando quieras."
            : googleResult === "error"
              ? "No pudimos conectar Google Calendar. Probá otra vez."
              : "",
    error: googleResult === "error",
  });

  const loadSettings = $(async () => {
    state.loading = true;
    state.loadError = false;
    try {
      const client = getSupabaseClient();
      const [general, whatsapp, professionals, services, user] =
        await Promise.all([
          client.from("app_settings").select("*").eq("id", true).single(),
          client.from("whatsapp_settings").select("*").eq("id", true).single(),
          client
            .from("professionals")
            .select("id")
            .eq("active", true)
            .order("created_at")
            .limit(1),
          client.from("services").select("*").order("sort_order").order("name"),
          client.auth.getUser(),
        ]);
      if (
        general.error ||
        whatsapp.error ||
        professionals.error ||
        services.error ||
        user.error
      ) {
        throw new Error("SETTINGS_LOAD_FAILED");
      }

      if (general.data) {
        const data = general.data as Record<string, unknown>;
        state.clinicName = (data.clinic_name as string) || BUSINESS_CONFIG.name;
        state.subtitle =
          (data.business_subtitle as string) || BUSINESS_CONFIG.subtitle;
        state.phone = (data.business_phone as string | null) ?? "";
        state.email = (data.business_email as string | null) ?? "";
        state.address = (data.business_address as string | null) ?? "";
        state.logoUrl = (data.logo_url as string | null) ?? "";
        state.timezone = (data.timezone as string) || BUSINESS_CONFIG.timezone;
        state.defaultDuration =
          (data.default_appointment_duration_minutes as number) ?? 30;
        state.bufferMinutes = (data.appointment_buffer_minutes as number) ?? 0;
        state.minimumNoticeMinutes =
          (data.minimum_booking_notice_minutes as number) ?? 120;
        state.reminder24h = Boolean(data.reminder_24h_enabled);
        state.reminderDayBeforeTime = cleanTime(
          (data.reminder_day_before_time as string | null) ?? "21:00",
        );
        state.reminder2h = Boolean(data.reminder_2h_enabled);
        state.reminder2hMinutes = (data.reminder_2h_minutes as number) ?? 120;
        state.automationWelcomeMessage =
          (data.automation_welcome_message as string | null) ?? "";
        state.depositEnabled = Boolean(data.deposit_enabled);
        state.depositAmountArs = Number(data.deposit_amount_ars ?? 0);
        state.depositAlias = (data.deposit_alias as string | null) ?? "";
        state.depositHolder = (data.deposit_holder as string | null) ?? "";
        state.bookingHoldMinutes = Number(data.booking_hold_minutes ?? 60);
        state.iomaDurationMinutes = Number(data.ioma_duration_minutes ?? 0);
        state.privateDurationMinutes = Number(
          data.private_duration_minutes ?? 0,
        );
        state.depositRequestMessageTemplate =
          (data.deposit_request_message_template as string | null) ?? "";
        state.depositProofReceivedMessageTemplate =
          (data.deposit_proof_received_message_template as string | null) ?? "";
        state.depositConfirmedMessageTemplate =
          (data.deposit_confirmed_message_template as string | null) ?? "";
        state.bookingHoldExpiredMessageTemplate =
          (data.booking_hold_expired_message_template as string | null) ?? "";
        state.outOfHoursEnabled = Boolean(data.out_of_hours_enabled);
        state.outOfHoursMessage =
          (data.out_of_hours_message as string | null) ?? "";
        state.outOfHoursCooldownMinutes =
          (data.out_of_hours_cooldown_minutes as number) ?? 720;
        state.urgentMessage = (data.urgent_message as string | null) ?? "";
        state.generalInfoMessage =
          (data.general_info_message as string | null) ?? "";
        state.aiEnabled = data.ai_enabled === true;
        state.aiMediaEnabled = data.ai_media_enabled === true;
        state.aiModel = "gpt-5.6-luna";
      }
      if (whatsapp.data) {
        state.whatsappStatus = whatsapp.data
          .integration_status as typeof state.whatsappStatus;
        state.whatsappPhone =
          (whatsapp.data.display_phone as string | null) ?? "";
        state.whatsappName =
          (whatsapp.data.display_name as string | null) ?? "";
        state.lastHealthCheck =
          (whatsapp.data.last_health_check_at as string | null) ?? "";
        state.whatsappQuality =
          (whatsapp.data.quality_rating as typeof state.whatsappQuality) ??
          "UNKNOWN";
        state.sendingPaused = Boolean(whatsapp.data.sending_paused);
        state.sendingPauseReason =
          (whatsapp.data.sending_pause_reason as string | null) ?? "";
      }
      state.professionalId =
        (professionals.data?.[0]?.id as string | undefined) ?? "";
      state.services = (services.data ?? []) as ServiceRow[];

      if (state.professionalId) {
        const [rules, blocks] = await Promise.all([
          client
            .from("availability_rules")
            .select("*")
            .eq("professional_id", state.professionalId)
            .order("weekday")
            .order("start_time"),
          client
            .from("availability_exceptions")
            .select("id,date,start_time,end_time,reason")
            .eq("professional_id", state.professionalId)
            .eq("type", "unavailable")
            .gte("date", new Date().toISOString().slice(0, 10))
            .order("date"),
        ]);
        if (rules.error || blocks.error) {
          throw new Error("SCHEDULE_LOAD_FAILED");
        }
        state.rules = (rules.data ?? []) as RuleRow[];
        state.blocks = (blocks.data ?? []) as BlockRow[];
      }

      const currentUser = user.data.user;
      if (currentUser) {
        const { data: profile, error: profileError } = await client
          .from("profiles")
          .select("role")
          .eq("id", currentUser.id)
          .single();
        if (profileError) throw profileError;
        state.isAdmin = profile?.role === "ADMIN";
      }
      if (state.isAdmin) {
        const { data: users, error: usersError } = await client
          .from("profiles")
          .select("id,full_name,role,active")
          .order("full_name");
        if (usersError) throw usersError;
        state.users = (users ?? []) as ProfileRow[];
      }
    } catch {
      state.loadError = true;
    } finally {
      state.loading = false;
    }
  });

  const loadGoogleCalendarStatus = $(async (): Promise<boolean> => {
    googleCalendar.loading = true;
    googleCalendar.error = false;
    try {
      const { data, error } = await getSupabaseClient().functions.invoke(
        "google-calendar-status",
        { method: "GET" },
      );
      if (error || !data) throw new Error("GOOGLE_CALENDAR_STATUS_FAILED");

      googleCalendar.configured = data.configured !== false;
      googleCalendar.connected = Boolean(data.connected);
      googleCalendar.selectionPending =
        data.selectionPending === true || data.status === "selection_required";
      if (
        !googleCalendar.selectionPending &&
        googleCalendar.message === GOOGLE_CALENDAR_SELECTION_REQUIRED_MESSAGE
      ) {
        googleCalendar.message = "";
      }
      googleCalendar.email = typeof data.email === "string" ? data.email : "";
      googleCalendar.calendarName =
        typeof data.calendarName === "string" ? data.calendarName : "";
      const lastCheckedAt =
        typeof data.lastCheckedAt === "string" ? data.lastCheckedAt : "";
      const inboundSyncState =
        typeof data.inboundSyncState === "string" ? data.inboundSyncState : "";
      const firstImportApproved = data.firstImportApproved === true;
      googleCalendar.lastCheckedAt = lastCheckedAt;
      googleCalendar.lastSyncError =
        typeof data.lastSyncError === "string" ? data.lastSyncError : "";
      googleCalendar.inboundSyncState = inboundSyncState;
      googleCalendar.firstImportApproved = firstImportApproved;
      googleCalendar.syncStatus = googleCalendarSyncStatus({
        status: data.status,
        firstImportApproved,
        inboundSyncState,
        lastCheckedAt,
      });
      googleCalendar.blockCount = Number(data.blockCount ?? 0);
      googleCalendar.unsupportedCount = Number(data.unsupportedCount ?? 0);
      googleCalendar.conflictCount = Number(data.conflictCount ?? 0);
      googleCalendar.conflictsError = "";
      if (googleCalendar.conflictCount > 0) {
        try {
          googleCalendar.conflicts =
            await loadCalendarConflicts(getSupabaseClient());
        } catch {
          googleCalendar.conflicts = [];
          googleCalendar.conflictsError =
            "Hay cambios pendientes, pero no pudimos cargar el detalle. Probá nuevamente antes de tomar una decisión.";
        }
      } else {
        googleCalendar.conflicts = [];
      }
      googleCalendar.lastSyncedAt =
        typeof data.lastSyncedAt === "string" ? data.lastSyncedAt : "";
      googleCalendar.pendingCount = Number(data.pendingCount ?? 0);
      googleCalendar.failedCount = Number(data.failedCount ?? 0);
      if (!googleCalendar.selectionPending) {
        googleCalendar.selectableCalendars = [];
        googleCalendar.selectableCalendarsLoaded = false;
        googleCalendar.selectableCalendarsError = "";
        googleCalendar.selectedCalendarId = "";
      }
      if (!googleCalendar.message && typeof data.message === "string") {
        googleCalendar.message = data.message;
      }
      googleCalendar.loaded = true;
      return true;
    } catch {
      googleCalendar.error = true;
      googleCalendar.message =
        "No pudimos consultar Google Calendar. Revisá tu conexión e intentá otra vez.";
      return false;
    } finally {
      googleCalendar.loading = false;
    }
  });

  const loadSelectableGoogleCalendars = $(async () => {
    if (
      !state.isAdmin ||
      !googleCalendar.selectionPending ||
      Boolean(googleCalendar.action) ||
      Boolean(googleCalendar.resolving)
    ) {
      return;
    }

    googleCalendar.action = "load-calendars";
    googleCalendar.selectableCalendarsError = "";
    try {
      const { data, error } = await getSupabaseClient().functions.invoke(
        "google-calendar-selection",
        { method: "GET" },
      );
      if (!error && data?.selectionRequired === false) {
        googleCalendar.selectionPending = false;
        googleCalendar.selectableCalendars = [];
        googleCalendar.selectableCalendarsLoaded = false;
        googleCalendar.selectableCalendarsError = "";
        googleCalendar.selectedCalendarId = "";
        await loadGoogleCalendarStatus();
        return;
      }
      if (error || !Array.isArray(data?.calendars)) {
        throw new Error("GOOGLE_CALENDAR_LIST_FAILED");
      }

      googleCalendar.selectableCalendars = parseSelectableGoogleCalendars(
        data.calendars,
      );
      googleCalendar.selectableCalendarsLoaded = true;
      if (
        !googleCalendar.selectableCalendars.some(
          (calendar) => calendar.id === googleCalendar.selectedCalendarId,
        )
      ) {
        googleCalendar.selectedCalendarId = "";
      }
    } catch {
      googleCalendar.selectableCalendars = [];
      googleCalendar.selectableCalendarsLoaded = false;
      googleCalendar.selectableCalendarsError =
        "No pudimos cargar tus calendarios. Probá nuevamente.";
    } finally {
      googleCalendar.action = "";
    }
  });

  const cancelGoogleCalendarSelection = $(async () => {
    if (
      !state.isAdmin ||
      Boolean(googleCalendar.action) ||
      Boolean(googleCalendar.resolving)
    )
      return;

    googleCalendar.action = "cancel-selection";
    googleCalendar.error = false;
    googleCalendar.message = "";
    try {
      const { data, error } = await getSupabaseClient().functions.invoke(
        "google-calendar-selection",
        { method: "DELETE" },
      );
      if (error || data?.cancelled !== true) {
        throw new Error("GOOGLE_CALENDAR_SELECTION_CANCEL_FAILED");
      }

      googleCalendar.selectionPending = false;
      googleCalendar.selectableCalendars = [];
      googleCalendar.selectableCalendarsLoaded = false;
      googleCalendar.selectableCalendarsError = "";
      googleCalendar.selectedCalendarId = "";
      await loadGoogleCalendarStatus();
      googleCalendar.message = googleCalendar.connected
        ? "Descartamos la selección. El calendario conectado no cambió."
        : "Descartamos la selección. Ya podés conectar la cuenta correcta.";
    } catch {
      googleCalendar.error = true;
      googleCalendar.message =
        "No pudimos descartar la selección. Probá nuevamente.";
    } finally {
      googleCalendar.action = "";
    }
  });

  useVisibleTask$(async () => {
    const currentUrl = new URL(window.location.href);
    if (currentUrl.searchParams.get("section") !== tab.value) {
      currentUrl.searchParams.set("section", tab.value);
      window.history.replaceState(
        window.history.state,
        "",
        `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`,
      );
    }

    await Promise.all([
      loadSettings(),
      tab.value === "google"
        ? loadGoogleCalendarStatus()
        : Promise.resolve(undefined),
    ]);
    if (
      tab.value === "google" &&
      state.isAdmin &&
      googleCalendar.selectionPending
    ) {
      await loadSelectableGoogleCalendars();
    }
  });

  const selectTab = $(async (nextTab: SettingsTab) => {
    tab.value = nextTab;

    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set("section", nextTab);
    nextUrl.searchParams.delete("google");
    nextUrl.searchParams.delete("google_calendar");
    window.history.replaceState(
      window.history.state,
      "",
      `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`,
    );

    if (nextTab === "google") {
      if (!googleCalendar.loaded) await loadGoogleCalendarStatus();
      if (
        state.isAdmin &&
        googleCalendar.selectionPending &&
        !googleCalendar.selectableCalendarsLoaded
      ) {
        await loadSelectableGoogleCalendars();
      }
    }
  });

  const saveAppSettings = $(
    async (values: Record<string, unknown>, success: string) => {
      const { error } = await getSupabaseClient()
        .from("app_settings")
        .update(values)
        .eq("id", true);
      notice.value = error
        ? "No pudimos guardar los cambios. Probá de nuevo."
        : success;
    },
  );
  const noticeIsError = notice.value.startsWith("No pudimos");

  return (
    <main class="section-shell">
      <AppNavigation active="settings" />
      <section
        id="app-content"
        class="section-page settings-page"
        tabIndex={-1}
      >
        <header class="section-page-header">
          <div>
            <span class="eyebrow">Administración</span>
            <h1>Configuración</h1>
            <p>
              Elegí qué querés configurar. Te mostramos una sola sección por
              vez.
            </p>
          </div>
          <ManualHelpLink section="primeros-pasos" label="Abrir Manual" />
        </header>

        {state.loading ? (
          <div class="section-empty">
            <span class="small-spinner" />
            <p>Cargando configuración…</p>
          </div>
        ) : state.loadError ? (
          <div class="section-empty" role="alert">
            <Icon name="alert" size={24} />
            <p>No pudimos cargar la configuración.</p>
            <button type="button" onClick$={() => loadSettings()}>
              Reintentar
            </button>
          </div>
        ) : (
          <div class="settings-layout">
            <label class="form-field settings-section-picker">
              <span>¿Qué querés configurar?</span>
              <select
                value={tab.value}
                onChange$={async (_, element) =>
                  selectTab(element.value as SettingsTab)
                }
              >
                <optgroup label="Lo más usado">
                  {mainTabs.map((item) => (
                    <option key={item.key} value={item.key}>
                      {item.label}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Más opciones">
                  {moreTabs.map((item) => (
                    <option key={item.key} value={item.key}>
                      {item.label}
                    </option>
                  ))}
                </optgroup>
              </select>
              <small>Elegí una opción para verla y cambiarla.</small>
            </label>

            <nav class="settings-menu" aria-label="Secciones de configuración">
              <span class="settings-menu-heading">Lo más usado</span>
              {mainTabs.map((item) => (
                <button
                  key={item.key}
                  class={{ active: tab.value === item.key }}
                  type="button"
                  aria-current={tab.value === item.key ? "page" : undefined}
                  onClick$={() => selectTab(item.key)}
                >
                  {item.label}
                </button>
              ))}
              <details
                class="settings-more-menu"
                open={moreTabs.some((item) => item.key === tab.value)}
              >
                <summary>Más opciones</summary>
                <div class="settings-more-menu-list">
                  {moreTabs.map((item) => (
                    <button
                      key={item.key}
                      class={{ active: tab.value === item.key }}
                      type="button"
                      aria-current={tab.value === item.key ? "page" : undefined}
                      onClick$={() => selectTab(item.key)}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </details>
            </nav>

            <div class="settings-content">
              {!state.isAdmin && (
                <div class="settings-policy-alert">
                  <Icon name="info" size={18} />
                  <span>
                    <strong>Estás viendo la configuración</strong>
                    <small>
                      Para hacer cambios, pedile ayuda a una persona
                      administradora.
                    </small>
                  </span>
                </div>
              )}
              {tab.value === "booking" && (
                <div class="settings-stack booking-settings">
                  <section class="settings-block">
                    <div>
                      <h2>WhatsApp y reservas</h2>
                      <p>
                        Definí la seña y cuánto dura cada turno. Después, el
                        sistema usa estos datos automáticamente al ofrecer un
                        horario.
                      </p>
                      <ManualHelpLink
                        section="senas"
                        label="¿Cómo funcionan las señas?"
                      />
                    </div>

                    <label class="settings-checkbox">
                      <input
                        type="checkbox"
                        checked={state.depositEnabled}
                        disabled={!state.isAdmin}
                        onChange$={(_, element) =>
                          (state.depositEnabled = element.checked)
                        }
                      />
                      <span>Pedir una seña para reservar un turno nuevo</span>
                    </label>

                    <div class="settings-form-grid">
                      <label class="form-field">
                        <span>Monto de la seña</span>
                        <input
                          type="number"
                          min={1}
                          max={100000000}
                          step={1}
                          value={state.depositAmountArs}
                          disabled={!state.isAdmin}
                          onInput$={(_, element) =>
                            (state.depositAmountArs = Number(element.value))
                          }
                        />
                        <small>En pesos argentinos, sin puntos ni comas.</small>
                      </label>
                      <label class="form-field">
                        <span>Alias para transferir</span>
                        <input
                          value={state.depositAlias}
                          disabled={!state.isAdmin}
                          minLength={3}
                          placeholder="Ej. GISELA.TURNOS"
                          onInput$={(_, element) =>
                            (state.depositAlias = element.value)
                          }
                        />
                      </label>
                      <label class="form-field">
                        <span>Titular de la cuenta</span>
                        <input
                          value={state.depositHolder}
                          disabled={!state.isAdmin}
                          minLength={3}
                          placeholder="Nombre que verá el paciente"
                          onInput$={(_, element) =>
                            (state.depositHolder = element.value)
                          }
                        />
                      </label>
                      <label class="form-field">
                        <span>Minutos para enviar el comprobante</span>
                        <input
                          type="number"
                          min={5}
                          max={1440}
                          step={5}
                          value={state.bookingHoldMinutes}
                          disabled={!state.isAdmin}
                          onInput$={(_, element) =>
                            (state.bookingHoldMinutes = Number(element.value))
                          }
                        />
                        <small>
                          Durante este tiempo el horario queda reservado.
                        </small>
                      </label>
                    </div>
                  </section>

                  <section class="settings-block">
                    <div>
                      <h2>Duración según cobertura</h2>
                      <p>
                        Al elegir IOMA o Particular, la agenda aplica esta
                        duración sin pedir ningún cálculo.
                      </p>
                    </div>
                    <div class="settings-form-grid">
                      <label class="form-field">
                        <span>Turno IOMA (minutos)</span>
                        <input
                          type="number"
                          min={5}
                          max={480}
                          step={5}
                          value={state.iomaDurationMinutes}
                          disabled={!state.isAdmin}
                          onInput$={(_, element) =>
                            (state.iomaDurationMinutes = Number(element.value))
                          }
                        />
                      </label>
                      <label class="form-field">
                        <span>Turno particular (minutos)</span>
                        <input
                          type="number"
                          min={5}
                          max={480}
                          step={5}
                          value={state.privateDurationMinutes}
                          disabled={!state.isAdmin}
                          onInput$={(_, element) =>
                            (state.privateDurationMinutes = Number(
                              element.value,
                            ))
                          }
                        />
                      </label>
                    </div>
                  </section>

                  <section class="settings-block">
                    <div>
                      <h2>Mensajes de WhatsApp</h2>
                      <p>
                        Estos textos se envían solos durante la reserva. Podés
                        cambiarlos sin tocar ninguna configuración técnica.
                      </p>
                    </div>
                    <label class="form-field automation-message-field">
                      <span>Mensaje de bienvenida</span>
                      <textarea
                        rows={5}
                        maxLength={1024}
                        value={state.automationWelcomeMessage}
                        disabled={!state.isAdmin}
                        onInput$={(_, element) =>
                          (state.automationWelcomeMessage = element.value)
                        }
                      />
                    </label>
                    <label class="form-field automation-message-field">
                      <span>Pedido de seña</span>
                      <textarea
                        rows={6}
                        maxLength={1024}
                        value={state.depositRequestMessageTemplate}
                        disabled={!state.isAdmin}
                        onInput$={(_, element) =>
                          (state.depositRequestMessageTemplate = element.value)
                        }
                      />
                      <small>
                        Podés usar {"{deposit_amount}"}, {"{deposit_alias}"} y
                        {" {deposit_holder}"}.
                      </small>
                    </label>

                    <details class="settings-message-options">
                      <summary>Ver otros mensajes de la reserva</summary>
                      <div class="settings-message-options-content">
                        <label class="form-field automation-message-field">
                          <span>Cuando un comprobante queda para revisión</span>
                          <textarea
                            rows={4}
                            maxLength={1024}
                            value={state.depositProofReceivedMessageTemplate}
                            disabled={!state.isAdmin}
                            onInput$={(_, element) =>
                              (state.depositProofReceivedMessageTemplate =
                                element.value)
                            }
                          />
                          <small>
                            Es un acuse para casos que no se autoconfirman; no
                            debe prometer que el turno ya está confirmado.
                          </small>
                        </label>
                        <label class="form-field automation-message-field">
                          <span>Confirmación de la seña</span>
                          <textarea
                            rows={4}
                            maxLength={1024}
                            value={state.depositConfirmedMessageTemplate}
                            disabled={!state.isAdmin}
                            onInput$={(_, element) =>
                              (state.depositConfirmedMessageTemplate =
                                element.value)
                            }
                          />
                          <small>
                            Podés usar {"{date}"} y {"{time}"} para la fecha y
                            hora del turno.
                          </small>
                        </label>
                        <label class="form-field automation-message-field">
                          <span>Cuando vence la reserva</span>
                          <textarea
                            rows={4}
                            maxLength={1024}
                            value={state.bookingHoldExpiredMessageTemplate}
                            disabled={!state.isAdmin}
                            onInput$={(_, element) =>
                              (state.bookingHoldExpiredMessageTemplate =
                                element.value)
                            }
                          />
                        </label>
                      </div>
                    </details>

                    <div class="settings-policy-alert">
                      <Icon name="info" size={18} />
                      <span>
                        <strong>Autoconfirmación básica</strong>
                        <small>
                          Si la lectura encuentra el monto exacto y el alias o
                          titular configurado, el turno se confirma. Si no,
                          queda para revisión manual. El comprobante sigue
                          disponible y podés cancelar el turno si detectás un
                          problema.
                        </small>
                      </span>
                    </div>

                    <button
                      class="primary-button"
                      type="button"
                      disabled={
                        !state.isAdmin ||
                        state.iomaDurationMinutes < 5 ||
                        state.iomaDurationMinutes > 480 ||
                        state.privateDurationMinutes < 5 ||
                        state.privateDurationMinutes > 480 ||
                        state.depositAmountArs < 1 ||
                        state.depositAmountArs > 100000000 ||
                        state.bookingHoldMinutes < 5 ||
                        state.bookingHoldMinutes > 1440 ||
                        state.depositAlias.trim().length < 3 ||
                        state.depositHolder.trim().length < 3 ||
                        !state.automationWelcomeMessage.trim() ||
                        !state.depositRequestMessageTemplate.trim() ||
                        !state.depositProofReceivedMessageTemplate.trim() ||
                        !state.depositConfirmedMessageTemplate.trim() ||
                        !state.bookingHoldExpiredMessageTemplate.trim()
                      }
                      onClick$={() =>
                        saveAppSettings(
                          {
                            deposit_enabled: state.depositEnabled,
                            deposit_amount_ars: state.depositAmountArs,
                            deposit_alias: state.depositAlias.trim(),
                            deposit_holder: state.depositHolder.trim(),
                            booking_hold_minutes: state.bookingHoldMinutes,
                            ioma_duration_minutes: state.iomaDurationMinutes,
                            private_duration_minutes:
                              state.privateDurationMinutes,
                            automation_welcome_message:
                              state.automationWelcomeMessage.trim(),
                            deposit_request_message_template:
                              state.depositRequestMessageTemplate.trim(),
                            deposit_proof_received_message_template:
                              state.depositProofReceivedMessageTemplate.trim(),
                            deposit_confirmed_message_template:
                              state.depositConfirmedMessageTemplate.trim(),
                            booking_hold_expired_message_template:
                              state.bookingHoldExpiredMessageTemplate.trim(),
                          },
                          "WhatsApp y reservas actualizados.",
                        )
                      }
                    >
                      Guardar WhatsApp y reservas
                    </button>
                  </section>
                </div>
              )}

              {tab.value === "office" && (
                <section class="settings-block">
                  <div>
                    <h2>Datos del consultorio</h2>
                    <p>
                      Completá solo los datos confirmados. Se usarán para
                      identificar el consultorio.
                    </p>
                  </div>
                  <div class="settings-form-grid">
                    <label class="form-field">
                      <span>Nombre</span>
                      <input
                        value={state.clinicName}
                        disabled={!state.isAdmin}
                        onInput$={(_, element) =>
                          (state.clinicName = element.value)
                        }
                      />
                    </label>
                    <label class="form-field">
                      <span>Subtítulo</span>
                      <input
                        value={state.subtitle}
                        disabled={!state.isAdmin}
                        onInput$={(_, element) =>
                          (state.subtitle = element.value)
                        }
                      />
                    </label>
                    <label class="form-field">
                      <span>
                        Teléfono <em>Opcional</em>
                      </span>
                      <input
                        inputMode="tel"
                        value={state.phone}
                        disabled={!state.isAdmin}
                        onInput$={(_, element) => (state.phone = element.value)}
                      />
                    </label>
                    <label class="form-field">
                      <span>
                        Email <em>Opcional</em>
                      </span>
                      <input
                        type="email"
                        value={state.email}
                        disabled={!state.isAdmin}
                        onInput$={(_, element) => (state.email = element.value)}
                      />
                    </label>
                    <label class="form-field settings-span-2">
                      <span>
                        Dirección <em>Opcional</em>
                      </span>
                      <input
                        value={state.address}
                        disabled={!state.isAdmin}
                        onInput$={(_, element) =>
                          (state.address = element.value)
                        }
                      />
                    </label>
                    <label class="form-field settings-span-2">
                      <span>
                        Enlace al logo <em>Opcional</em>
                      </span>
                      <input
                        type="url"
                        value={state.logoUrl}
                        disabled={!state.isAdmin}
                        onInput$={(_, element) =>
                          (state.logoUrl = element.value)
                        }
                      />
                    </label>
                    <label class="form-field settings-span-2">
                      <span>Zona horaria de la agenda</span>
                      <input
                        value={state.timezone}
                        disabled={!state.isAdmin}
                        onInput$={(_, element) =>
                          (state.timezone = element.value)
                        }
                      />
                    </label>
                  </div>
                  <button
                    class="primary-button"
                    type="button"
                    disabled={!state.isAdmin}
                    onClick$={() =>
                      saveAppSettings(
                        {
                          clinic_name: state.clinicName.trim(),
                          business_subtitle: state.subtitle.trim(),
                          business_phone: state.phone.trim() || null,
                          business_email: state.email.trim() || null,
                          business_address: state.address.trim() || null,
                          logo_url: state.logoUrl.trim() || null,
                          timezone: state.timezone.trim(),
                        },
                        "Datos del consultorio guardados.",
                      )
                    }
                  >
                    Guardar datos
                  </button>
                </section>
              )}

              {tab.value === "hours" && (
                <div class="settings-stack">
                  <section class="settings-block">
                    <div>
                      <h2>Horarios de atención</h2>
                      <p>
                        Cargá los días y horas en los que se pueden dar turnos.
                        Si atendés mañana y tarde, agregá dos horarios para ese
                        día.
                      </p>
                      <ManualHelpLink
                        section="turnos"
                        label="¿Cómo afectan los horarios a los turnos?"
                      />
                    </div>
                    <div class="settings-record-list">
                      {state.rules.length ? (
                        state.rules.map((rule) => (
                          <div key={rule.id}>
                            <span>
                              <strong>{weekdays[rule.weekday]}</strong>
                              <small>
                                {cleanTime(rule.start_time)}–
                                {cleanTime(rule.end_time)} · turnos cada{" "}
                                {rule.slot_minutes} minutos ·{" "}
                                {rule.active ? "abierto" : "cerrado"}
                              </small>
                            </span>
                            <span class="record-actions">
                              <button
                                type="button"
                                disabled={!state.isAdmin}
                                onClick$={async () => {
                                  if (
                                    rule.active &&
                                    !globalThis.confirm(
                                      `¿Cerrar el horario del ${weekdays[rule.weekday]} de ${cleanTime(rule.start_time)} a ${cleanTime(rule.end_time)}? No aparecerá para turnos nuevos.`,
                                    )
                                  )
                                    return;
                                  const { error } = await getSupabaseClient()
                                    .from("availability_rules")
                                    .update({ active: !rule.active })
                                    .eq("id", rule.id);
                                  if (!error) {
                                    rule.active = !rule.active;
                                    notice.value = rule.active
                                      ? "El horario volvió a estar disponible."
                                      : "El horario quedó cerrado.";
                                  } else
                                    notice.value =
                                      "No pudimos cambiar el horario.";
                                }}
                              >
                                {rule.active
                                  ? "Cerrar este horario"
                                  : "Volver a abrir"}
                              </button>
                              <button
                                type="button"
                                disabled={!state.isAdmin}
                                onClick$={async () => {
                                  if (
                                    !globalThis.confirm(
                                      `¿Eliminar el horario del ${weekdays[rule.weekday]} de ${cleanTime(rule.start_time)} a ${cleanTime(rule.end_time)}?`,
                                    )
                                  )
                                    return;
                                  const { error } = await getSupabaseClient()
                                    .from("availability_rules")
                                    .delete()
                                    .eq("id", rule.id);
                                  if (!error) {
                                    await loadSettings();
                                    notice.value = "Horario eliminado.";
                                  } else
                                    notice.value =
                                      "No pudimos eliminar la franja.";
                                }}
                              >
                                Eliminar
                              </button>
                            </span>
                          </div>
                        ))
                      ) : (
                        <p class="settings-note">
                          Todavía no hay horarios. Agregá el primero debajo.
                        </p>
                      )}
                    </div>
                    <div class="settings-inline-form settings-hours-form">
                      <label class="form-field">
                        <span>Día</span>
                        <select
                          value={newRuleWeekday.value}
                          disabled={!state.isAdmin}
                          onChange$={(_, element) =>
                            (newRuleWeekday.value = Number(element.value))
                          }
                        >
                          {weekdays.map((day, index) => (
                            <option key={day} value={index}>
                              {day}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label class="form-field">
                        <span>Desde</span>
                        <input
                          type="time"
                          value={newRuleStart.value}
                          disabled={!state.isAdmin}
                          onInput$={(_, element) =>
                            (newRuleStart.value = element.value)
                          }
                        />
                      </label>
                      <label class="form-field">
                        <span>Hasta</span>
                        <input
                          type="time"
                          value={newRuleEnd.value}
                          disabled={!state.isAdmin}
                          onInput$={(_, element) =>
                            (newRuleEnd.value = element.value)
                          }
                        />
                      </label>
                      <button
                        class="primary-button"
                        type="button"
                        disabled={
                          !state.isAdmin ||
                          !state.professionalId ||
                          newRuleStart.value >= newRuleEnd.value
                        }
                        onClick$={async () => {
                          if (
                            !globalThis.confirm(
                              `¿Agregar este horario? ${weekdays[newRuleWeekday.value]}, de ${newRuleStart.value} a ${newRuleEnd.value}.`,
                            )
                          )
                            return;
                          const { error } = await getSupabaseClient()
                            .from("availability_rules")
                            .insert({
                              professional_id: state.professionalId,
                              weekday: newRuleWeekday.value,
                              start_time: newRuleStart.value,
                              end_time: newRuleEnd.value,
                              slot_minutes: state.defaultDuration,
                            });
                          if (error)
                            notice.value = "No pudimos agregar la franja.";
                          else {
                            await loadSettings();
                            notice.value = "Horario agregado.";
                          }
                        }}
                      >
                        Agregar horario
                      </button>
                    </div>
                  </section>

                  <section class="settings-block">
                    <div>
                      <h2>Días y horarios cerrados</h2>
                      <p>
                        Usá esta opción para feriados, vacaciones o momentos en
                        los que no vas a atender.
                      </p>
                    </div>
                    <div class="settings-record-list">
                      {state.blocks.length ? (
                        state.blocks.map((block) => (
                          <div key={block.id}>
                            <span>
                              <strong>
                                {new Intl.DateTimeFormat("es-AR", {
                                  dateStyle: "medium",
                                  timeZone: "UTC",
                                }).format(new Date(`${block.date}T12:00:00Z`))}
                              </strong>
                              <small>
                                {block.start_time && block.end_time
                                  ? `${cleanTime(block.start_time)}–${cleanTime(block.end_time)}`
                                  : "Día completo"}
                                {block.reason ? ` · ${block.reason}` : ""}
                              </small>
                            </span>
                            <button
                              type="button"
                              disabled={!state.isAdmin}
                              onClick$={async () => {
                                if (
                                  !globalThis.confirm(
                                    "¿Quitar este cierre? Ese horario volverá a estar disponible para dar turnos.",
                                  )
                                )
                                  return;
                                const { error } = await getSupabaseClient()
                                  .from("availability_exceptions")
                                  .delete()
                                  .eq("id", block.id);
                                if (!error) {
                                  await loadSettings();
                                  notice.value =
                                    "El horario volvió a estar disponible.";
                                } else
                                  notice.value =
                                    "No pudimos eliminar el bloqueo.";
                              }}
                            >
                              Quitar cierre
                            </button>
                          </div>
                        ))
                      ) : (
                        <p class="settings-note">
                          No hay días ni horarios cerrados próximamente.
                        </p>
                      )}
                    </div>
                    <div class="settings-inline-form settings-block-form">
                      <label class="form-field">
                        <span>Fecha</span>
                        <input
                          type="date"
                          value={newBlockDate.value}
                          disabled={!state.isAdmin}
                          onInput$={(_, element) =>
                            (newBlockDate.value = element.value)
                          }
                        />
                      </label>
                      <label class="form-field">
                        <span>
                          Desde <em>Opcional</em>
                        </span>
                        <input
                          type="time"
                          value={newBlockStart.value}
                          disabled={!state.isAdmin}
                          onInput$={(_, element) =>
                            (newBlockStart.value = element.value)
                          }
                        />
                      </label>
                      <label class="form-field">
                        <span>
                          Hasta <em>Opcional</em>
                        </span>
                        <input
                          type="time"
                          value={newBlockEnd.value}
                          disabled={!state.isAdmin}
                          onInput$={(_, element) =>
                            (newBlockEnd.value = element.value)
                          }
                        />
                      </label>
                      <label class="form-field">
                        <span>
                          Motivo <em>Opcional</em>
                        </span>
                        <input
                          value={newBlockReason.value}
                          disabled={!state.isAdmin}
                          onInput$={(_, element) =>
                            (newBlockReason.value = element.value)
                          }
                        />
                      </label>
                      <button
                        class="primary-button"
                        type="button"
                        disabled={
                          !state.isAdmin ||
                          !state.professionalId ||
                          !newBlockDate.value ||
                          Boolean(newBlockStart.value) !==
                            Boolean(newBlockEnd.value) ||
                          (Boolean(newBlockStart.value) &&
                            newBlockStart.value >= newBlockEnd.value)
                        }
                        onClick$={async () => {
                          const selectedDate = formatSettingsDate(
                            newBlockDate.value,
                          );
                          const closureDescription = newBlockStart.value
                            ? `el ${selectedDate}, de ${newBlockStart.value} a ${newBlockEnd.value}`
                            : `durante todo el día del ${selectedDate}`;
                          if (
                            !globalThis.confirm(
                              `¿Cerrar la agenda ${closureDescription}?`,
                            )
                          )
                            return;
                          const { error } = await getSupabaseClient()
                            .from("availability_exceptions")
                            .insert({
                              professional_id: state.professionalId,
                              date: newBlockDate.value,
                              start_time: newBlockStart.value || null,
                              end_time: newBlockEnd.value || null,
                              type: "unavailable",
                              reason: newBlockReason.value.trim() || null,
                            });
                          if (error)
                            notice.value = "No pudimos crear el bloqueo.";
                          else {
                            newBlockDate.value = "";
                            newBlockStart.value = "";
                            newBlockEnd.value = "";
                            newBlockReason.value = "";
                            await loadSettings();
                            notice.value = "Bloqueo agregado.";
                          }
                        }}
                      >
                        Cerrar este horario
                      </button>
                    </div>
                  </section>
                </div>
              )}

              {tab.value === "appointments" && (
                <div class="settings-stack">
                  <section class="settings-block">
                    <div>
                      <h2>Reglas de turnos</h2>
                      <p>
                        Ajustá el descanso entre pacientes y con cuánta
                        anticipación se puede reservar.
                      </p>
                      <ManualHelpLink
                        section="turnos"
                        label="¿Cómo funcionan los turnos?"
                      />
                    </div>
                    <div class="settings-form-grid">
                      <label class="form-field">
                        <span>Descanso entre turnos (minutos)</span>
                        <input
                          type="number"
                          min={0}
                          max={120}
                          value={state.bufferMinutes}
                          disabled={!state.isAdmin}
                          onInput$={(_, element) =>
                            (state.bufferMinutes = Number(element.value))
                          }
                        />
                      </label>
                      <label class="form-field">
                        <span>Tiempo mínimo para reservar (minutos)</span>
                        <input
                          type="number"
                          min={0}
                          max={43200}
                          value={state.minimumNoticeMinutes}
                          disabled={!state.isAdmin}
                          onInput$={(_, element) =>
                            (state.minimumNoticeMinutes = Number(element.value))
                          }
                        />
                      </label>
                    </div>
                    <button
                      class="primary-button"
                      type="button"
                      disabled={!state.isAdmin}
                      onClick$={() =>
                        saveAppSettings(
                          {
                            appointment_buffer_minutes: state.bufferMinutes,
                            minimum_booking_notice_minutes:
                              state.minimumNoticeMinutes,
                          },
                          "Reglas de turnos guardadas.",
                        )
                      }
                    >
                      Guardar tiempos
                    </button>
                  </section>
                  <section class="settings-block">
                    <div>
                      <h2>Servicios</h2>
                      <p>
                        Escribí los motivos de atención que querés ofrecer. La
                        duración se toma automáticamente de IOMA o Particular.
                      </p>
                    </div>
                    <div class="settings-record-list service-settings-list">
                      {state.services.map((service) => (
                        <div key={service.id}>
                          <span>
                            <input
                              aria-label={`Nombre de ${service.name}`}
                              value={service.name}
                              disabled={!state.isAdmin}
                              onInput$={(_, element) =>
                                (service.name = element.value)
                              }
                            />
                            <input
                              aria-label={`Descripción de ${service.name}`}
                              value={service.description ?? ""}
                              placeholder="Descripción opcional"
                              disabled={!state.isAdmin}
                              onInput$={(_, element) =>
                                (service.description =
                                  element.value.trimStart() || null)
                              }
                            />
                            <small>
                              Duración automática · posición en la lista
                              <input
                                aria-label={`Orden de ${service.name}`}
                                type="number"
                                min={0}
                                max={10000}
                                value={service.sort_order}
                                disabled={!state.isAdmin}
                                onInput$={(_, element) =>
                                  (service.sort_order = Number(element.value))
                                }
                              />
                            </small>
                          </span>
                          <span class="record-actions">
                            <button
                              type="button"
                              disabled={!state.isAdmin}
                              onClick$={async () => {
                                const { error } = await getSupabaseClient()
                                  .from("services")
                                  .update({
                                    name: service.name.trim(),
                                    description:
                                      service.description?.trim() || null,
                                    sort_order: service.sort_order,
                                  })
                                  .eq("id", service.id);
                                notice.value = error
                                  ? "No pudimos guardar el servicio."
                                  : "Servicio guardado.";
                              }}
                            >
                              Guardar
                            </button>
                            <button
                              type="button"
                              disabled={!state.isAdmin}
                              onClick$={async () => {
                                if (
                                  service.active &&
                                  !globalThis.confirm(
                                    `¿Desactivar “${service.name}”? Ya no se ofrecerá para turnos nuevos.`,
                                  )
                                )
                                  return;
                                const { error } = await getSupabaseClient()
                                  .from("services")
                                  .update({ active: !service.active })
                                  .eq("id", service.id);
                                if (!error) {
                                  service.active = !service.active;
                                  notice.value = service.active
                                    ? "Servicio activado."
                                    : "Servicio desactivado.";
                                } else {
                                  notice.value =
                                    "No pudimos cambiar el servicio.";
                                }
                              }}
                            >
                              {service.active ? "Desactivar" : "Activar"}
                            </button>
                            <button
                              type="button"
                              disabled={!state.isAdmin}
                              onClick$={async () => {
                                if (
                                  !globalThis.confirm(
                                    `¿Eliminar “${service.name}”? Si ya tiene turnos, no podrá eliminarse y conviene desactivarlo.`,
                                  )
                                )
                                  return;
                                const { error } = await getSupabaseClient()
                                  .from("services")
                                  .delete()
                                  .eq("id", service.id);
                                if (error)
                                  notice.value =
                                    "No se puede eliminar porque tiene turnos asociados. Podés desactivarlo.";
                                else {
                                  await loadSettings();
                                  notice.value = "Servicio eliminado.";
                                }
                              }}
                            >
                              Eliminar
                            </button>
                          </span>
                        </div>
                      ))}
                    </div>
                    <div class="settings-inline-form">
                      <label class="form-field">
                        <span>Nombre</span>
                        <input
                          value={newServiceName.value}
                          placeholder="Ej. Consulta"
                          disabled={!state.isAdmin}
                          onInput$={(_, element) =>
                            (newServiceName.value = element.value)
                          }
                        />
                      </label>
                      <label class="form-field">
                        <span>
                          Descripción <em>Opcional</em>
                        </span>
                        <input
                          value={newServiceDescription.value}
                          placeholder="Ej. Primera visita o control"
                          disabled={!state.isAdmin}
                          onInput$={(_, element) =>
                            (newServiceDescription.value = element.value)
                          }
                        />
                      </label>
                      <button
                        class="primary-button"
                        type="button"
                        disabled={
                          !state.isAdmin || !newServiceName.value.trim()
                        }
                        onClick$={async () => {
                          const { error } = await getSupabaseClient()
                            .from("services")
                            .insert({
                              name: newServiceName.value.trim(),
                              description:
                                newServiceDescription.value.trim() || null,
                              // Campo legado requerido por la tabla. La reserva
                              // real usa la duración configurada por cobertura.
                              duration_minutes: state.defaultDuration,
                              sort_order:
                                Math.max(
                                  0,
                                  ...state.services.map(
                                    (service) => service.sort_order,
                                  ),
                                ) + 10,
                            });
                          if (error)
                            notice.value = "No pudimos crear el servicio.";
                          else {
                            newServiceName.value = "";
                            newServiceDescription.value = "";
                            await loadSettings();
                            notice.value = "Servicio agregado.";
                          }
                        }}
                      >
                        Agregar servicio
                      </button>
                    </div>
                  </section>
                </div>
              )}

              {tab.value === "google" && (
                <section
                  class="settings-block google-calendar-settings"
                  aria-busy={
                    googleCalendar.loading || Boolean(googleCalendar.action)
                  }
                >
                  <div>
                    <h2>Google Calendar</h2>
                    <p>
                      {state.isAdmin
                        ? "Conectá una cuenta una sola vez para ver también los turnos confirmados del consultorio en Google Calendar."
                        : "Acá podés comprobar si los turnos confirmados se están copiando a Google Calendar. La conexión la prepara la persona administradora."}
                    </p>
                    <ManualHelpLink
                      section="calendario"
                      label="¿Cómo se sincroniza el calendario?"
                    />
                  </div>

                  {googleCalendar.message && (
                    <div
                      class={{
                        "google-calendar-feedback": true,
                        error: googleCalendar.error,
                      }}
                      role={googleCalendar.error ? "alert" : "status"}
                      aria-live={googleCalendar.error ? "assertive" : "polite"}
                    >
                      <Icon
                        name={googleCalendar.error ? "alert" : "info"}
                        size={19}
                      />
                      <span>{googleCalendar.message}</span>
                    </div>
                  )}

                  {googleCalendar.loading && !googleCalendar.loaded ? (
                    <div
                      class="google-calendar-loading"
                      role="status"
                      aria-live="polite"
                    >
                      <span class="small-spinner" />
                      <span>Comprobando la conexión…</span>
                    </div>
                  ) : googleCalendar.selectionPending && state.isAdmin ? (
                    <div class="google-calendar-card google-calendar-selection">
                      <div class="google-calendar-card-heading">
                        <span class="google-calendar-icon">
                          <Icon name="calendar" size={25} />
                        </span>
                        <span>
                          <strong>Elegí el calendario del consultorio</strong>
                          <small>
                            Google ya autorizó la cuenta. Falta confirmar dónde
                            se van a sincronizar los turnos.
                          </small>
                        </span>
                        <span
                          class="google-calendar-state pending"
                          role="status"
                        >
                          <i />
                          Falta confirmar
                        </span>
                      </div>

                      <p class="google-calendar-selection-intro">
                        Seleccioná uno de los calendarios que administrás. La
                        sincronización actual no cambia hasta que confirmes,
                        para evitar mezclar agendas.
                      </p>

                      {googleCalendar.action === "load-calendars" ? (
                        <div
                          class="google-calendar-loading"
                          role="status"
                          aria-live="polite"
                        >
                          <span class="small-spinner" />
                          <span>Cargando tus calendarios…</span>
                        </div>
                      ) : googleCalendar.selectableCalendarsError ? (
                        <div class="google-calendar-selection-retry">
                          <div
                            class="google-calendar-feedback error"
                            role="alert"
                          >
                            <Icon name="alert" size={19} />
                            <span>
                              {googleCalendar.selectableCalendarsError}
                            </span>
                          </div>
                          <button
                            class="secondary-button"
                            type="button"
                            disabled={
                              Boolean(googleCalendar.action) ||
                              Boolean(googleCalendar.resolving)
                            }
                            onClick$={loadSelectableGoogleCalendars}
                          >
                            Volver a intentar
                          </button>
                        </div>
                      ) : googleCalendar.selectableCalendarsLoaded ? (
                        googleCalendar.selectableCalendars.length > 0 ? (
                          <fieldset class="google-calendar-choice-fieldset">
                            <legend>Calendarios disponibles</legend>
                            <ul class="google-calendar-choice-list">
                              {googleCalendar.selectableCalendars.map(
                                (calendar) => (
                                  <li key={calendar.id}>
                                    <label
                                      class={{
                                        selected:
                                          googleCalendar.selectedCalendarId ===
                                          calendar.id,
                                        incompatible:
                                          calendar.timeZone !== state.timezone,
                                      }}
                                    >
                                      <input
                                        type="radio"
                                        name="google-calendar-choice"
                                        disabled={
                                          calendar.timeZone !== state.timezone
                                        }
                                        checked={
                                          googleCalendar.selectedCalendarId ===
                                          calendar.id
                                        }
                                        onChange$={() => {
                                          googleCalendar.selectedCalendarId =
                                            calendar.id;
                                        }}
                                      />
                                      <span>
                                        <span class="google-calendar-choice-name">
                                          <strong>{calendar.name}</strong>
                                          {calendar.primary && (
                                            <small>Principal</small>
                                          )}
                                        </span>
                                        <small>
                                          {calendar.timeZone
                                            ? calendar.timeZone ===
                                              state.timezone
                                              ? `Zona horaria: ${calendar.timeZone}`
                                              : `Zona horaria: ${calendar.timeZone} · No coincide con la agenda`
                                            : "Zona horaria no informada"}
                                        </small>
                                      </span>
                                    </label>
                                  </li>
                                ),
                              )}
                            </ul>
                          </fieldset>
                        ) : (
                          <div
                            class="google-calendar-feedback error"
                            role="alert"
                          >
                            <Icon name="alert" size={19} />
                            <span>
                              No encontramos un calendario que esta cuenta pueda
                              administrar.
                            </span>
                          </div>
                        )
                      ) : (
                        <button
                          class="secondary-button google-calendar-load-button"
                          type="button"
                          disabled={
                            Boolean(googleCalendar.action) ||
                            Boolean(googleCalendar.resolving)
                          }
                          onClick$={loadSelectableGoogleCalendars}
                        >
                          Cargar calendarios
                        </button>
                      )}

                      <div class="google-calendar-actions">
                        <button
                          class="secondary-button"
                          type="button"
                          disabled={
                            Boolean(googleCalendar.action) ||
                            Boolean(googleCalendar.resolving)
                          }
                          onClick$={cancelGoogleCalendarSelection}
                        >
                          {googleCalendar.action === "cancel-selection"
                            ? "Descartando…"
                            : "Elegir otra cuenta"}
                        </button>
                        {googleCalendar.selectableCalendars.length > 0 && (
                          <button
                            class="primary-button"
                            type="button"
                            disabled={
                              !googleCalendar.selectedCalendarId ||
                              Boolean(googleCalendar.action) ||
                              Boolean(googleCalendar.resolving)
                            }
                            onClick$={async () => {
                              if (
                                !state.isAdmin ||
                                Boolean(googleCalendar.action) ||
                                Boolean(googleCalendar.resolving)
                              ) {
                                return;
                              }
                              const selectedCalendar =
                                googleCalendar.selectableCalendars.find(
                                  (calendar) =>
                                    calendar.id ===
                                    googleCalendar.selectedCalendarId,
                                );
                              if (!selectedCalendar) return;

                              googleCalendar.action = "select-calendar";
                              googleCalendar.error = false;
                              googleCalendar.message = "";
                              try {
                                const { data, error } =
                                  await getSupabaseClient().functions.invoke(
                                    "google-calendar-selection",
                                    {
                                      method: "POST",
                                      body: {
                                        calendarId:
                                          googleCalendar.selectedCalendarId,
                                      },
                                    },
                                  );
                                if (
                                  error ||
                                  data?.selected !== true ||
                                  data?.connected !== true
                                ) {
                                  const failureCode =
                                    await googleCalendarFunctionErrorCode(
                                      data,
                                      error,
                                    );
                                  throw new Error(
                                    failureCode ||
                                      "GOOGLE_CALENDAR_SELECTION_FAILED",
                                  );
                                }

                                googleCalendar.connected = true;
                                googleCalendar.selectionPending = false;
                                googleCalendar.calendarName =
                                  typeof data.calendarName === "string"
                                    ? data.calendarName
                                    : selectedCalendar.name;
                                googleCalendar.selectableCalendars = [];
                                googleCalendar.selectableCalendarsLoaded = false;
                                googleCalendar.selectableCalendarsError = "";
                                googleCalendar.selectedCalendarId = "";
                                googleCalendar.preview = null;
                                googleCalendar.message =
                                  "Calendario confirmado. Ya podés revisar la importación inicial antes de sincronizar.";
                                await loadGoogleCalendarStatus();
                              } catch (error) {
                                googleCalendar.error = true;
                                googleCalendar.message =
                                  describeGoogleCalendarSelectionError(
                                    error instanceof Error ? error.message : "",
                                  );
                              } finally {
                                googleCalendar.action = "";
                              }
                            }}
                          >
                            {googleCalendar.action === "select-calendar"
                              ? "Confirmando…"
                              : "Confirmar calendario"}
                          </button>
                        )}
                      </div>
                    </div>
                  ) : googleCalendar.connected ||
                    googleCalendar.syncStatus === "reconnect" ? (
                    <div class="google-calendar-card">
                      <div class="google-calendar-card-heading">
                        <span class="google-calendar-icon">
                          <Icon name="calendar" size={25} />
                        </span>
                        <span>
                          <strong>Calendario conectado</strong>
                          <small>
                            Los turnos confirmados y sus cambios se copian
                            automáticamente en pocos minutos. Los turnos aún
                            programados no se envían.
                          </small>
                        </span>
                        <span
                          class={{
                            "google-calendar-state": true,
                            pending:
                              googleCalendar.syncStatus === "pending" ||
                              googleCalendar.syncStatus === "first_import" ||
                              googleCalendar.syncStatus === "not_checked",
                            reconnect:
                              googleCalendar.syncStatus === "reconnect" ||
                              googleCalendar.syncStatus === "attention",
                          }}
                          role="status"
                        >
                          <i />
                          {googleCalendar.syncStatus === "pending"
                            ? "Sincronizando"
                            : googleCalendar.syncStatus === "first_import"
                              ? "Importación pendiente"
                              : googleCalendar.syncStatus === "not_checked"
                                ? "Sin revisión"
                                : googleCalendar.syncStatus === "attention"
                                  ? "Revisar sincronización"
                                  : googleCalendar.syncStatus === "reconnect"
                                    ? "Volver a conectar"
                                    : "Todo al día"}
                        </span>
                      </div>

                      <dl class="google-calendar-details">
                        <div>
                          <dt>Cuenta conectada</dt>
                          <dd>{googleCalendar.email || "Cuenta de Google"}</dd>
                        </div>
                        <div>
                          <dt>Calendario</dt>
                          <dd>
                            {googleCalendar.calendarName ||
                              "Calendario del consultorio"}
                          </dd>
                        </div>
                        <div>
                          <dt>Última revisión</dt>
                          <dd>
                            {formatLastCalendarSync(
                              googleCalendar.lastCheckedAt,
                            )}
                          </dd>
                        </div>
                        <div>
                          <dt>Último cambio</dt>
                          <dd>
                            {googleCalendar.lastSyncedAt
                              ? formatLastCalendarSync(
                                  googleCalendar.lastSyncedAt,
                                )
                              : "Todavía no hubo cambios"}
                          </dd>
                        </div>
                        <div>
                          <dt>Bloqueos traídos de Google</dt>
                          <dd>
                            {googleCalendar.blockCount}
                            {googleCalendar.unsupportedCount > 0
                              ? ` · ${googleCalendar.unsupportedCount} evento(s) sin importar`
                              : ""}
                          </dd>
                        </div>
                      </dl>

                      {googleCalendar.unsupportedCount > 0 && (
                        <p class="settings-note">
                          Hay eventos cuya ocupación todavía no se pudo
                          verificar. Mientras quede alguno pendiente, la agenda
                          no ofrece horarios ni envía cambios a Google, para
                          evitar dobles reservas. No hace falta modificar el
                          calendario: volvé a revisarlo para obtener el estado
                          actualizado.
                        </p>
                      )}

                      <div class="google-calendar-note">
                        <Icon name="info" size={18} />
                        <span>
                          <strong>Los turnos se administran desde acá.</strong>
                          Si cambiás o cancelás un turno confirmado en esta
                          aplicación, el cambio se envía a Google Calendar en
                          pocos minutos. Los eventos que crees a mano en Google
                          aparecen acá como bloqueos de agenda, nunca como
                          turnos de pacientes.
                        </span>
                      </div>

                      {state.isAdmin &&
                        googleCalendar.inboundSyncState !== "incremental" && (
                          <div class="calendar-first-import">
                            <h3>Traer los eventos que ya están en Google</h3>
                            <p>
                              {googleCalendar.firstImportApproved
                                ? "La importación ya está habilitada, pero todavía no terminó. Revisá nuevamente el calendario antes de reintentar."
                                : "Todavía no importamos nada. La revisión y la importación inicial sólo leen Google: no crean, modifican ni eliminan eventos."}
                            </p>
                            {googleCalendar.preview && (
                              <>
                                <ul class="calendar-preview-list">
                                  <li>
                                    <strong>
                                      {googleCalendar.preview.managedEvents}
                                    </strong>{" "}
                                    eventos administrados por esta versión de la
                                    agenda
                                  </li>
                                  <li>
                                    <strong>
                                      {googleCalendar.preview.externalEvents}
                                    </strong>{" "}
                                    eventos u ocurrencias externos dentro del
                                    horizonte revisado
                                  </li>
                                  <li>
                                    <strong>
                                      {
                                        googleCalendar.preview
                                          .legacyManagedEvents
                                      }
                                    </strong>{" "}
                                    eventos de una integración anterior sin un
                                    turno asociado
                                  </li>
                                  <li>
                                    <strong>
                                      {googleCalendar.preview.recurringSeries}
                                    </strong>{" "}
                                    series recurrentes, expandidas en{" "}
                                    <strong>
                                      {
                                        googleCalendar.preview
                                          .recurringOccurrences
                                      }
                                    </strong>{" "}
                                    ocurrencias activas
                                  </li>
                                  <li>
                                    <strong>
                                      {
                                        googleCalendar.preview
                                          .cancelledRecurringOccurrences
                                      }
                                    </strong>{" "}
                                    ocurrencias recurrentes canceladas que no
                                    bloquearán horarios
                                  </li>
                                  <li>
                                    <strong>
                                      {googleCalendar.preview.allDayEvents}
                                    </strong>{" "}
                                    eventos u ocurrencias de todo el día
                                  </li>
                                  <li>
                                    <strong>
                                      {googleCalendar.preview.freeEventsIgnored}
                                    </strong>{" "}
                                    eventos marcados como libres en Google que
                                    no bloquearán horarios
                                  </li>
                                  <li>
                                    <strong>
                                      {googleCalendar.preview.wouldBecomeBlocks}
                                    </strong>{" "}
                                    ocupaciones pasarían a ser bloqueos de
                                    agenda
                                  </li>
                                  <li>
                                    <strong>
                                      {googleCalendar.preview.unsupportedEvents}
                                    </strong>{" "}
                                    no se pudieron interpretar con seguridad
                                  </li>
                                </ul>
                                <p class="settings-note">
                                  Horizonte comprobado: desde{" "}
                                  {formatSettingsDate(
                                    googleCalendar.preview.coverageStartDate,
                                  )}{" "}
                                  hasta antes del{" "}
                                  {formatSettingsDate(
                                    googleCalendar.preview
                                      .coverageEndDateExclusive,
                                  )}
                                  . Las series se cuentan una vez y sus
                                  ocurrencias por separado; los grupos pueden
                                  superponerse.
                                </p>
                                {(googleCalendar.preview.truncated ||
                                  googleCalendar.preview.unsupportedEvents >
                                    0) && (
                                  <div
                                    class="google-calendar-feedback error"
                                    role="alert"
                                  >
                                    <Icon name="alert" size={19} />
                                    <span>
                                      {googleCalendar.preview.truncated
                                        ? "El calendario tiene demasiados eventos para una revisión completa. No habilites la importación."
                                        : "No pudimos verificar la ocupación de todos los eventos dentro del horizonte. No modificamos Google ni habilitamos la importación."}
                                    </span>
                                  </div>
                                )}
                              </>
                            )}
                            <div class="calendar-first-import-actions">
                              <button
                                class={
                                  googleCalendar.preview
                                    ? "secondary-button"
                                    : "primary-button"
                                }
                                type="button"
                                disabled={
                                  Boolean(googleCalendar.action) ||
                                  Boolean(googleCalendar.resolving)
                                }
                                onClick$={async () => {
                                  if (
                                    Boolean(googleCalendar.action) ||
                                    Boolean(googleCalendar.resolving)
                                  ) {
                                    return;
                                  }
                                  googleCalendar.action = "preview";
                                  googleCalendar.error = false;
                                  googleCalendar.message = "";
                                  googleCalendar.preview = null;
                                  try {
                                    const { data, error } =
                                      await getSupabaseClient().functions.invoke(
                                        "process-calendar-sync",
                                        {
                                          method: "POST",
                                          body: { mode: "preview" },
                                        },
                                      );
                                    const preview =
                                      parseCalendarImportPreview(data);
                                    if (error || !preview) {
                                      throw new Error(
                                        "CALENDAR_PREVIEW_FAILED",
                                      );
                                    }
                                    googleCalendar.preview = preview;
                                    googleCalendar.message =
                                      "Revisamos el calendario sin importar nada todavía.";
                                  } catch {
                                    googleCalendar.error = true;
                                    googleCalendar.message =
                                      "No pudimos revisar el calendario. Probá nuevamente.";
                                  } finally {
                                    googleCalendar.action = "";
                                  }
                                }}
                              >
                                {googleCalendar.action === "preview"
                                  ? "Revisando…"
                                  : "1. Ver qué hay en Google"}
                              </button>
                              <button
                                class="primary-button"
                                type="button"
                                disabled={
                                  Boolean(googleCalendar.action) ||
                                  Boolean(googleCalendar.resolving) ||
                                  !googleCalendar.preview ||
                                  googleCalendar.preview.truncated ||
                                  googleCalendar.preview.unsupportedEvents > 0
                                }
                                onClick$={async () => {
                                  if (
                                    Boolean(googleCalendar.action) ||
                                    Boolean(googleCalendar.resolving)
                                  ) {
                                    return;
                                  }
                                  const reviewedPreview =
                                    googleCalendar.preview;
                                  if (!reviewedPreview) return;

                                  googleCalendar.action = "approve";
                                  googleCalendar.error = false;
                                  googleCalendar.message = "";
                                  let phase:
                                    | "rechecking"
                                    | "approving"
                                    | "importing"
                                    | "refreshing" = "rechecking";
                                  let approvalSaved =
                                    googleCalendar.firstImportApproved;
                                  let importCompleted = false;
                                  let completedSummaryMessage = "";
                                  try {
                                    // El calendario puede cambiar entre el
                                    // primer resumen y la confirmación. Volvemos
                                    // a leerlo antes de guardar la aprobación.
                                    const {
                                      data: recheckedData,
                                      error: recheckedError,
                                    } =
                                      await getSupabaseClient().functions.invoke(
                                        "process-calendar-sync",
                                        {
                                          method: "POST",
                                          body: { mode: "preview" },
                                        },
                                      );
                                    const recheckedPreview =
                                      parseCalendarImportPreview(recheckedData);
                                    if (recheckedError || !recheckedPreview) {
                                      throw new Error(
                                        "CALENDAR_PREVIEW_RECHECK_FAILED",
                                      );
                                    }
                                    if (
                                      !sameCalendarImportPreview(
                                        reviewedPreview,
                                        recheckedPreview,
                                      )
                                    ) {
                                      googleCalendar.preview = recheckedPreview;
                                      googleCalendar.error = true;
                                      googleCalendar.message =
                                        "El calendario cambió desde la revisión. Actualizamos el resumen y no importamos nada. Revisalo antes de continuar.";
                                      return;
                                    }
                                    googleCalendar.preview = recheckedPreview;

                                    if (!approvalSaved) {
                                      if (
                                        !window.confirm(
                                          `¿Habilitar e importar la ocupación ya existente en Google?\n\n${recheckedPreview.wouldBecomeBlocks} ocupación(es) pasarán a bloquear horarios en la agenda. Esta importación sólo lee Google: no crea, modifica ni elimina eventos.`,
                                        )
                                      ) {
                                        return;
                                      }

                                      phase = "approving";
                                      const { data, error } =
                                        await getSupabaseClient().functions.invoke(
                                          "process-calendar-sync",
                                          {
                                            method: "POST",
                                            body: {
                                              mode: "approve_first_import",
                                            },
                                          },
                                        );
                                      if (error || data?.approved !== true) {
                                        throw new Error(
                                          "CALENDAR_APPROVE_FAILED",
                                        );
                                      }
                                      approvalSaved = true;
                                      googleCalendar.firstImportApproved = true;
                                    }

                                    phase = "importing";
                                    const {
                                      data: importData,
                                      error: importError,
                                    } =
                                      await getSupabaseClient().functions.invoke(
                                        "process-calendar-sync",
                                        {
                                          method: "POST",
                                          body: { mode: "initial_import" },
                                        },
                                      );
                                    const rawSummary = importData?.summary;
                                    const rawInbound = importData?.inbound;
                                    const summary =
                                      parseCalendarSyncSummary(rawSummary);
                                    const outcome = parseCalendarSyncOutcome(
                                      importData?.outcome,
                                    );
                                    if (
                                      importError ||
                                      importData?.processed !== true ||
                                      importData?.mode !== "initial_import" ||
                                      importData?.ignored === true ||
                                      importData?.reconnectRequired === true ||
                                      !rawSummary ||
                                      typeof rawSummary !== "object" ||
                                      Array.isArray(rawSummary) ||
                                      !rawInbound ||
                                      typeof rawInbound !== "object" ||
                                      Array.isArray(rawInbound) ||
                                      outcome !== "completed" ||
                                      summary.failed > 0 ||
                                      rawInbound.error !== null ||
                                      rawInbound.skippedReason !== null ||
                                      rawInbound.truncated !== false
                                    ) {
                                      throw new Error(
                                        "CALENDAR_INITIAL_IMPORT_FAILED",
                                      );
                                    }

                                    importCompleted = true;
                                    completedSummaryMessage =
                                      describeCalendarSync({
                                        summary,
                                        outcome,
                                        checkedAt: new Date(),
                                      });
                                    phase = "refreshing";
                                    const refreshed =
                                      await loadGoogleCalendarStatus();
                                    if (
                                      !refreshed ||
                                      googleCalendar.inboundSyncState !==
                                        "incremental"
                                    ) {
                                      throw new Error(
                                        "CALENDAR_INITIAL_IMPORT_UNCONFIRMED",
                                      );
                                    }
                                    googleCalendar.preview = null;
                                    googleCalendar.error = false;
                                    googleCalendar.message = `Importación inicial completada. ${completedSummaryMessage}`;
                                  } catch {
                                    if (phase === "rechecking") {
                                      googleCalendar.error = true;
                                      googleCalendar.message =
                                        "No pudimos volver a revisar el calendario. No habilitamos ni importamos nada; probá nuevamente.";
                                      return;
                                    }

                                    if (importCompleted) {
                                      googleCalendar.error = true;
                                      googleCalendar.message = `Importación inicial completada. ${completedSummaryMessage} No pudimos actualizar el estado del panel; recargá la página antes de volver a intentarlo.`;
                                      return;
                                    }

                                    const refreshed =
                                      await loadGoogleCalendarStatus();
                                    if (
                                      refreshed &&
                                      googleCalendar.inboundSyncState ===
                                        "incremental"
                                    ) {
                                      googleCalendar.preview = null;
                                      googleCalendar.error = true;
                                      googleCalendar.message =
                                        "La importación quedó registrada, pero no recibimos un resultado completo. Revisá el estado antes de sincronizar nuevamente.";
                                      return;
                                    }

                                    googleCalendar.error = true;
                                    if (
                                      approvalSaved ||
                                      googleCalendar.firstImportApproved
                                    ) {
                                      googleCalendar.message =
                                        "La habilitación quedó guardada, pero la importación no se completó. No se perdió la aprobación: revisá el resumen y tocá «Reintentar importación».";
                                    } else {
                                      googleCalendar.message =
                                        "No pudimos confirmar la habilitación y no importamos eventos. Probá nuevamente.";
                                    }
                                  } finally {
                                    googleCalendar.action = "";
                                  }
                                }}
                              >
                                {googleCalendar.action === "approve"
                                  ? googleCalendar.firstImportApproved
                                    ? "Importando…"
                                    : "Habilitando e importando…"
                                  : googleCalendar.preview
                                    ? googleCalendar.firstImportApproved
                                      ? "2. Reintentar importación"
                                      : "2. Habilitar e importar"
                                    : "2. Primero revisá el calendario"}
                              </button>
                            </div>
                          </div>
                        )}

                      {(googleCalendar.conflictCount > 0 ||
                        googleCalendar.conflicts.length > 0) && (
                        <div class="calendar-conflicts">
                          <h3>Cambios hechos en Google que hay que revisar</h3>
                          <p>
                            Alguien movió, borró o modificó en Google un turno
                            de un paciente. No lo cambiamos solos: decidí vos.
                          </p>
                          {googleCalendar.conflictsError ? (
                            <div class="google-calendar-selection-retry">
                              <div
                                class="google-calendar-feedback error"
                                role="alert"
                              >
                                <Icon name="alert" size={19} />
                                <span>{googleCalendar.conflictsError}</span>
                              </div>
                              <button
                                class="secondary-button"
                                type="button"
                                disabled={
                                  googleCalendar.loading ||
                                  Boolean(googleCalendar.action) ||
                                  Boolean(googleCalendar.resolving)
                                }
                                onClick$={loadGoogleCalendarStatus}
                              >
                                {googleCalendar.loading
                                  ? "Reintentando…"
                                  : "Volver a intentar"}
                              </button>
                            </div>
                          ) : (
                            <ul>
                              {googleCalendar.conflicts.map((conflict) => (
                                <li key={conflict.id}>
                                  <div>
                                    <strong>{conflict.contactName}</strong>
                                    <span>
                                      {conflict.kind ===
                                      "cancellation_requested"
                                        ? "Se borró el evento en Google."
                                        : conflict.kind === "metadata_changed"
                                          ? "Se modificaron datos del evento en Google. El turno en la agenda no cambió."
                                          : `Se movió al ${formatLastCalendarSync(
                                              conflict.proposedStartsAt ?? "",
                                            )}.`}
                                    </span>
                                  </div>
                                  <div class="calendar-conflict-actions">
                                    <button
                                      class="secondary-button"
                                      type="button"
                                      disabled={
                                        !state.isAdmin ||
                                        Boolean(googleCalendar.resolving) ||
                                        Boolean(googleCalendar.action)
                                      }
                                      onClick$={async () => {
                                        if (
                                          !state.isAdmin ||
                                          Boolean(googleCalendar.resolving) ||
                                          Boolean(googleCalendar.action)
                                        ) {
                                          return;
                                        }
                                        googleCalendar.resolving = conflict.id;
                                        googleCalendar.resolvingAction =
                                          "reject";
                                        googleCalendar.error = false;
                                        googleCalendar.message = "";
                                        try {
                                          const { error } =
                                            await getSupabaseClient().rpc(
                                              "reject_google_calendar_conflict",
                                              { p_conflict_id: conflict.id },
                                            );
                                          if (error) throw error;

                                          googleCalendar.conflicts =
                                            googleCalendar.conflicts.filter(
                                              (item) => item.id !== conflict.id,
                                            );
                                          googleCalendar.conflictCount =
                                            Math.max(
                                              0,
                                              googleCalendar.conflictCount - 1,
                                            );
                                          const refreshed =
                                            await loadGoogleCalendarStatus();
                                          googleCalendar.error = !refreshed;
                                          googleCalendar.message = refreshed
                                            ? "Dejamos el turno como está acá y lo vamos a restaurar en Google."
                                            : "La decisión se guardó, pero no pudimos actualizar la vista. Recargá esta sección antes de continuar.";
                                        } catch {
                                          const refreshed =
                                            await loadGoogleCalendarStatus();
                                          googleCalendar.error = true;
                                          googleCalendar.message = refreshed
                                            ? "No pudimos confirmar si la decisión se guardó. Revisá el estado antes de volver a intentar."
                                            : "No pudimos confirmar si la decisión se guardó ni recargar el estado. Recargá esta sección antes de volver a intentar.";
                                        } finally {
                                          googleCalendar.resolving = "";
                                          googleCalendar.resolvingAction = "";
                                        }
                                      }}
                                    >
                                      {googleCalendar.resolving ===
                                        conflict.id &&
                                      googleCalendar.resolvingAction ===
                                        "reject"
                                        ? "Guardando…"
                                        : "Restaurar desde la agenda"}
                                    </button>
                                    {conflict.kind !== "metadata_changed" && (
                                      <button
                                        class="primary-button"
                                        type="button"
                                        disabled={
                                          !state.isAdmin ||
                                          Boolean(googleCalendar.resolving) ||
                                          Boolean(googleCalendar.action)
                                        }
                                        onClick$={async () => {
                                          if (
                                            !state.isAdmin ||
                                            Boolean(googleCalendar.resolving) ||
                                            Boolean(googleCalendar.action)
                                          ) {
                                            return;
                                          }
                                          if (
                                            !window.confirm(
                                              conflict.kind ===
                                                "cancellation_requested"
                                                ? "¿Cancelar este turno en la agenda?"
                                                : "¿Mover este turno al horario que quedó en Google?",
                                            )
                                          ) {
                                            return;
                                          }
                                          googleCalendar.resolving =
                                            conflict.id;
                                          googleCalendar.resolvingAction =
                                            "apply";
                                          googleCalendar.error = false;
                                          googleCalendar.message = "";
                                          try {
                                            const { error } =
                                              await getSupabaseClient().rpc(
                                                "apply_google_calendar_conflict",
                                                { p_conflict_id: conflict.id },
                                              );
                                            if (error) throw error;

                                            googleCalendar.conflicts =
                                              googleCalendar.conflicts.filter(
                                                (item) =>
                                                  item.id !== conflict.id,
                                              );
                                            googleCalendar.conflictCount =
                                              Math.max(
                                                0,
                                                googleCalendar.conflictCount -
                                                  1,
                                              );
                                            const refreshed =
                                              await loadGoogleCalendarStatus();
                                            googleCalendar.error = !refreshed;
                                            googleCalendar.message = refreshed
                                              ? "Aplicamos el cambio en la agenda."
                                              : "El cambio se guardó, pero no pudimos actualizar la vista. Recargá esta sección antes de continuar.";
                                          } catch {
                                            const refreshed =
                                              await loadGoogleCalendarStatus();
                                            googleCalendar.error = true;
                                            googleCalendar.message = refreshed
                                              ? "No pudimos confirmar si el cambio se aplicó. Revisá el estado antes de volver a intentar."
                                              : "No pudimos confirmar si el cambio se aplicó ni recargar el estado. Recargá esta sección antes de volver a intentar.";
                                          } finally {
                                            googleCalendar.resolving = "";
                                            googleCalendar.resolvingAction = "";
                                          }
                                        }}
                                      >
                                        {googleCalendar.resolving ===
                                          conflict.id &&
                                        googleCalendar.resolvingAction ===
                                          "apply"
                                          ? "Aplicando…"
                                          : "Aplicar cambio"}
                                      </button>
                                    )}
                                  </div>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      )}

                      {state.isAdmin && (
                        <div class="google-calendar-actions">
                          {googleCalendar.syncStatus === "reconnect" && (
                            <button
                              class="primary-button"
                              type="button"
                              disabled={
                                Boolean(googleCalendar.action) ||
                                Boolean(googleCalendar.resolving)
                              }
                              onClick$={async () => {
                                if (
                                  Boolean(googleCalendar.action) ||
                                  Boolean(googleCalendar.resolving)
                                ) {
                                  return;
                                }
                                googleCalendar.action = "connect";
                                googleCalendar.error = false;
                                googleCalendar.message = "";
                                try {
                                  const { data, error } =
                                    await getSupabaseClient().functions.invoke(
                                      "google-calendar-oauth-start",
                                      { method: "POST" },
                                    );
                                  if (
                                    error ||
                                    typeof data?.authorizationUrl !== "string"
                                  ) {
                                    throw new Error(
                                      "GOOGLE_CALENDAR_OAUTH_FAILED",
                                    );
                                  }
                                  window.location.assign(data.authorizationUrl);
                                } catch {
                                  googleCalendar.error = true;
                                  googleCalendar.message =
                                    "No pudimos abrir Google. Probá nuevamente.";
                                  googleCalendar.action = "";
                                }
                              }}
                            >
                              {googleCalendar.action === "connect"
                                ? "Abriendo Google…"
                                : "Volver a conectar"}
                            </button>
                          )}
                          <button
                            class={
                              googleCalendar.syncStatus === "reconnect"
                                ? "secondary-button"
                                : "primary-button"
                            }
                            type="button"
                            disabled={
                              !canRunManualGoogleCalendarSync(
                                googleCalendar.firstImportApproved,
                                googleCalendar.inboundSyncState,
                              ) ||
                              Boolean(googleCalendar.action) ||
                              Boolean(googleCalendar.resolving)
                            }
                            onClick$={async () => {
                              if (
                                !canRunManualGoogleCalendarSync(
                                  googleCalendar.firstImportApproved,
                                  googleCalendar.inboundSyncState,
                                )
                              ) {
                                googleCalendar.error = false;
                                googleCalendar.message =
                                  "Completá la importación inicial desde el panel anterior antes de sincronizar nuevamente.";
                                return;
                              }
                              if (
                                Boolean(googleCalendar.action) ||
                                Boolean(googleCalendar.resolving)
                              ) {
                                return;
                              }
                              googleCalendar.action = "sync";
                              googleCalendar.error = false;
                              googleCalendar.message = "";
                              try {
                                const { data, error } =
                                  await getSupabaseClient().functions.invoke(
                                    "process-calendar-sync",
                                    {
                                      method: "POST",
                                      body: { mode: "manual" },
                                    },
                                  );
                                if (
                                  error ||
                                  data?.processed !== true ||
                                  data?.reconnectRequired === true ||
                                  data?.ignored === true
                                ) {
                                  throw new Error(
                                    "GOOGLE_CALENDAR_SYNC_FAILED",
                                  );
                                }
                                // El panel vuelve a leer el estado siempre,
                                // también cuando no hubo un solo cambio.
                                await loadGoogleCalendarStatus();
                                const summary = parseCalendarSyncSummary(
                                  data?.summary,
                                );
                                const outcome = parseCalendarSyncOutcome(
                                  data?.outcome,
                                );
                                googleCalendar.error =
                                  outcome === "error" || summary.failed > 0;
                                googleCalendar.message =
                                  summary.failed > 0
                                    ? "Algunos turnos necesitan revisión. La agenda sigue guardada de forma segura."
                                    : describeCalendarSync({
                                        summary,
                                        outcome,
                                        checkedAt:
                                          googleCalendar.lastCheckedAt ||
                                          new Date(),
                                        skippedReason:
                                          typeof data?.inbound
                                            ?.skippedReason === "string"
                                            ? data.inbound.skippedReason
                                            : null,
                                        error:
                                          typeof data?.inbound?.error ===
                                          "string"
                                            ? data.inbound.error
                                            : null,
                                      });
                              } catch {
                                googleCalendar.error = true;
                                googleCalendar.message =
                                  "No pudimos sincronizar ahora. Probá nuevamente en unos minutos.";
                              } finally {
                                googleCalendar.action = "";
                              }
                            }}
                          >
                            {googleCalendar.inboundSyncState !== "incremental"
                              ? "Completá la importación primero"
                              : googleCalendar.action === "sync"
                                ? "Sincronizando…"
                                : "Sincronizar ahora"}
                          </button>
                          <button
                            class="secondary-button danger-button"
                            type="button"
                            disabled={
                              Boolean(googleCalendar.action) ||
                              Boolean(googleCalendar.resolving)
                            }
                            onClick$={async () => {
                              if (
                                Boolean(googleCalendar.action) ||
                                Boolean(googleCalendar.resolving)
                              ) {
                                return;
                              }
                              const confirmed = window.confirm(
                                "¿Querés desconectar Google Calendar? Los turnos seguirán guardados en esta aplicación, pero dejarán de enviarse a Google.",
                              );
                              if (!confirmed) return;

                              googleCalendar.action = "disconnect";
                              googleCalendar.error = false;
                              googleCalendar.message = "";
                              try {
                                const { data, error } =
                                  await getSupabaseClient().functions.invoke(
                                    "google-calendar-disconnect",
                                    { method: "POST" },
                                  );
                                if (error || data?.disconnected !== true) {
                                  throw new Error(
                                    "GOOGLE_CALENDAR_DISCONNECT_FAILED",
                                  );
                                }
                                googleCalendar.connected = false;
                                googleCalendar.email = "";
                                googleCalendar.calendarName = "";
                                googleCalendar.lastSyncedAt = "";
                                googleCalendar.syncStatus = "synced";
                                googleCalendar.message =
                                  data.remoteRevocationConfirmed === true
                                    ? "Google Calendar fue desconectado. Tus turnos siguen guardados acá."
                                    : "La conexión local fue eliminada y tus turnos siguen guardados. Google no confirmó la revocación: quitá el acceso desde tu cuenta de Google antes de conectar otra cuenta.";
                              } catch {
                                googleCalendar.error = true;
                                googleCalendar.message =
                                  "No pudimos desconectar Google Calendar. Probá nuevamente.";
                              } finally {
                                googleCalendar.action = "";
                              }
                            }}
                          >
                            {googleCalendar.action === "disconnect"
                              ? "Desconectando…"
                              : "Desconectar"}
                          </button>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div class="google-calendar-card google-calendar-empty">
                      <span class="google-calendar-icon">
                        <Icon name="calendar" size={28} />
                      </span>
                      <div>
                        <h3>
                          {state.isAdmin
                            ? "Conectá tu Google Calendar"
                            : "Google Calendar no está conectado"}
                        </h3>
                        <p>
                          {state.isAdmin
                            ? "Al tocar el botón, Google te pedirá elegir una cuenta y aceptar el acceso al calendario. No necesitás copiar claves ni completar datos técnicos."
                            : "Pedile a la persona administradora que haga la conexión una sola vez. Después la sincronización es automática."}
                        </p>
                      </div>
                      {!googleCalendar.configured && (
                        <div class="google-calendar-feedback" role="alert">
                          <Icon name="alert" size={19} />
                          <span>
                            La conexión todavía no está preparada. Pedile ayuda
                            a la persona que configuró la aplicación.
                          </span>
                        </div>
                      )}
                      {state.isAdmin && (
                        <button
                          class="primary-button"
                          type="button"
                          disabled={
                            !googleCalendar.configured ||
                            Boolean(googleCalendar.action) ||
                            Boolean(googleCalendar.resolving)
                          }
                          onClick$={async () => {
                            if (
                              Boolean(googleCalendar.action) ||
                              Boolean(googleCalendar.resolving)
                            ) {
                              return;
                            }
                            googleCalendar.action = "connect";
                            googleCalendar.error = false;
                            googleCalendar.message = "";
                            try {
                              const { data, error } =
                                await getSupabaseClient().functions.invoke(
                                  "google-calendar-oauth-start",
                                  { method: "POST" },
                                );
                              if (
                                error ||
                                typeof data?.authorizationUrl !== "string"
                              ) {
                                throw new Error("GOOGLE_CALENDAR_OAUTH_FAILED");
                              }
                              window.location.assign(data.authorizationUrl);
                            } catch {
                              googleCalendar.error = true;
                              googleCalendar.message =
                                "No pudimos abrir Google. Probá nuevamente.";
                              googleCalendar.action = "";
                            }
                          }}
                        >
                          {googleCalendar.action === "connect"
                            ? "Abriendo Google…"
                            : "Conectar con Google"}
                        </button>
                      )}
                    </div>
                  )}
                </section>
              )}

              {tab.value === "reminders" && (
                <section class="settings-block">
                  <div>
                    <h2>Recordatorios</h2>
                    <p>
                      Cada noche se envía un WhatsApp a quienes tienen turno al
                      día siguiente.
                    </p>
                    <ManualHelpLink
                      section="automatizacion"
                      label="¿Cómo funciona la atención automática?"
                    />
                  </div>
                  <label class="settings-checkbox">
                    <input
                      type="checkbox"
                      checked={state.reminder24h}
                      disabled={!state.isAdmin}
                      onChange$={(_, element) =>
                        (state.reminder24h = element.checked)
                      }
                    />
                    <span>Recordar los turnos de mañana</span>
                  </label>
                  <label class="form-field">
                    <span>Hora de envío</span>
                    <input
                      type="time"
                      value={state.reminderDayBeforeTime}
                      disabled={!state.isAdmin || !state.reminder24h}
                      onInput$={(_, element) =>
                        (state.reminderDayBeforeTime = element.value)
                      }
                    />
                  </label>
                  <div>
                    <h3>Otro recordatorio (opcional)</h3>
                    <p>
                      Si querés, también podés avisar nuevamente poco antes del
                      turno.
                    </p>
                  </div>
                  <label class="settings-checkbox">
                    <input
                      type="checkbox"
                      checked={state.reminder2h}
                      disabled={!state.isAdmin}
                      onChange$={(_, element) =>
                        (state.reminder2h = element.checked)
                      }
                    />
                    <span>Enviar otro aviso el mismo día</span>
                  </label>
                  <label class="form-field">
                    <span>Horas antes del turno</span>
                    <input
                      type="number"
                      min={1}
                      max={168}
                      value={state.reminder2hMinutes / 60}
                      disabled={!state.isAdmin || !state.reminder2h}
                      onInput$={(_, element) =>
                        (state.reminder2hMinutes = Number(element.value) * 60)
                      }
                    />
                  </label>
                  <div class="settings-policy-alert">
                    <Icon name="info" size={18} />
                    <span>
                      <strong>Importante</strong>
                      <small>
                        Los avisos funcionan cuando WhatsApp y el envío
                        automático están habilitados.
                      </small>
                    </span>
                  </div>
                  <button
                    class="primary-button"
                    type="button"
                    disabled={!state.isAdmin}
                    onClick$={() =>
                      saveAppSettings(
                        {
                          reminder_24h_enabled: state.reminder24h,
                          reminder_day_before_time: state.reminderDayBeforeTime,
                          reminder_2h_enabled: state.reminder2h,
                          reminder_2h_minutes: state.reminder2hMinutes,
                        },
                        "Recordatorios actualizados.",
                      )
                    }
                  >
                    Guardar recordatorios
                  </button>
                </section>
              )}

              {tab.value === "automation" && (
                <section class="settings-block">
                  <div>
                    <h2>Mensajes automáticos</h2>
                    <p>
                      Estas respuestas se envían solas. Revisalas con cuidado;
                      si alguien menciona una urgencia, la conversación pasa a
                      una persona.
                    </p>
                    <ManualHelpLink
                      section="automatizacion"
                      label="¿Cómo funciona la atención automática?"
                    />
                  </div>
                  <label class="settings-checkbox">
                    <input
                      type="checkbox"
                      checked={state.outOfHoursEnabled}
                      disabled={!state.isAdmin}
                      onChange$={(_, element) =>
                        (state.outOfHoursEnabled = element.checked)
                      }
                    />
                    <span>Responder fuera de horario</span>
                  </label>
                  <label class="form-field automation-message-field">
                    <span>Mensaje fuera de horario</span>
                    <textarea
                      rows={4}
                      maxLength={1024}
                      value={state.outOfHoursMessage}
                      disabled={!state.isAdmin}
                      onInput$={(_, element) =>
                        (state.outOfHoursMessage = element.value)
                      }
                    />
                  </label>
                  <label class="form-field">
                    <span>No repetir antes de (minutos)</span>
                    <input
                      type="number"
                      min={60}
                      max={10080}
                      value={state.outOfHoursCooldownMinutes}
                      disabled={!state.isAdmin}
                      onInput$={(_, element) =>
                        (state.outOfHoursCooldownMinutes = Number(
                          element.value,
                        ))
                      }
                    />
                  </label>
                  <label class="form-field automation-message-field">
                    <span>Mensaje ante urgencia</span>
                    <textarea
                      rows={4}
                      maxLength={1024}
                      value={state.urgentMessage}
                      disabled={!state.isAdmin}
                      onInput$={(_, element) =>
                        (state.urgentMessage = element.value)
                      }
                    />
                  </label>
                  <label class="form-field automation-message-field">
                    <span>Información general</span>
                    <textarea
                      rows={4}
                      maxLength={1024}
                      placeholder="Solo completar con dirección, horarios o datos confirmados."
                      value={state.generalInfoMessage}
                      disabled={!state.isAdmin}
                      onInput$={(_, element) =>
                        (state.generalInfoMessage = element.value)
                      }
                    />
                  </label>
                  <div>
                    <h3>Asistente de IA para información administrativa</h3>
                    <p>
                      Puede redactar únicamente respuestas sobre horarios y
                      ubicación usando la dirección y las reglas de horarios ya
                      configuradas. No recibe el mensaje original ni datos del
                      paciente.
                    </p>
                  </div>
                  <label class="settings-checkbox">
                    <input
                      type="checkbox"
                      checked={state.aiEnabled}
                      disabled={!state.isAdmin}
                      onChange$={(_, element) =>
                        (state.aiEnabled = element.checked)
                      }
                    />
                    <span>Usar IA sólo para horarios y ubicación</span>
                  </label>
                  <label class="settings-checkbox">
                    <input
                      type="checkbox"
                      checked={state.aiMediaEnabled}
                      disabled={!state.isAdmin}
                      onChange$={(_, element) =>
                        (state.aiMediaEnabled = element.checked)
                      }
                    />
                    <span>
                      Transcribir audios y leer comprobantes con IA
                      <small>
                        Envía el audio o el comprobante recibido para
                        transcribirlo o copiar sus datos. Si el comprobante es
                        legible y coinciden el monto y el alias o titular, la
                        seña y el turno se confirman automáticamente. Si no, lo
                        revisás vos. Siempre podés revisar el archivo y cancelar
                        el turno después.
                      </small>
                    </span>
                  </label>
                  <label class="form-field">
                    <span>Modelo fijado por el backend</span>
                    <input
                      type="text"
                      value={state.aiModel}
                      readOnly
                      disabled
                    />
                  </label>
                  <div class="settings-policy-alert">
                    <Icon name="info" size={18} />
                    <span>
                      <strong>La IA tiene un interruptor independiente</strong>
                      <small>
                        Aunque se marque acá, no funciona mientras las
                        automatizaciones globales estén apagadas. Ante datos
                        faltantes o una consulta sensible, deriva a Gisela.
                      </small>
                    </span>
                  </div>
                  {containsRestrictedAutomationRequest(
                    `${state.outOfHoursMessage} ${state.urgentMessage} ${state.generalInfoMessage}`,
                  ) && (
                    <div class="settings-policy-alert" role="alert">
                      <Icon name="alert" size={18} />
                      <span>
                        <strong>
                          Este mensaje pide datos que no corresponden
                        </strong>
                        <small>
                          Quitá pedidos de documentos, datos bancarios o
                          información médica antes de guardar.
                        </small>
                      </span>
                    </div>
                  )}
                  <button
                    class="primary-button"
                    type="button"
                    disabled={
                      !state.isAdmin ||
                      containsRestrictedAutomationRequest(
                        `${state.outOfHoursMessage} ${state.urgentMessage} ${state.generalInfoMessage}`,
                      )
                    }
                    onClick$={() =>
                      saveAppSettings(
                        {
                          out_of_hours_enabled: state.outOfHoursEnabled,
                          out_of_hours_message: state.outOfHoursMessage.trim(),
                          out_of_hours_cooldown_minutes:
                            state.outOfHoursCooldownMinutes,
                          urgent_message: state.urgentMessage.trim(),
                          general_info_message:
                            state.generalInfoMessage.trim() || null,
                          ai_enabled: state.aiEnabled,
                          ai_media_enabled: state.aiMediaEnabled,
                          ai_model: "gpt-5.6-luna",
                        },
                        "Automatización guardada.",
                      )
                    }
                  >
                    Guardar mensajes
                  </button>
                </section>
              )}

              {tab.value === "whatsapp" && (
                <section class="settings-block integration-block">
                  <div>
                    <h2>Estado de WhatsApp</h2>
                    <p>
                      Acá podés comprobar si el número está listo para recibir y
                      enviar mensajes.
                    </p>
                    <ManualHelpLink
                      section="whatsapp"
                      label="¿Cómo funciona WhatsApp?"
                    />
                  </div>
                  <div class="integration-summary">
                    <span>
                      <Icon name="message" size={20} />
                    </span>
                    <div>
                      <strong>
                        {state.whatsappStatus === "connected"
                          ? state.whatsappName || "WhatsApp conectado"
                          : state.whatsappStatus === "error"
                            ? "Problema de conexión"
                            : "WhatsApp no configurado"}
                      </strong>
                      <small>
                        {state.whatsappPhone ||
                          "Todavía no se configuró un número de Meta."}
                      </small>
                    </div>
                    <span
                      class={{
                        "integration-state": true,
                        off: state.whatsappStatus !== "connected",
                      }}
                    >
                      <i />
                      {state.whatsappStatus === "connected"
                        ? "Conectado"
                        : "Sin conectar"}
                    </span>
                  </div>
                  <div class="whatsapp-policy-summary">
                    <div>
                      <span>Respuestas automáticas</span>
                      <strong
                        class={
                          botAutomation.enabled !== true ? "sending-paused" : ""
                        }
                      >
                        {botAutomation.enabled === null
                          ? "Sin comprobar"
                          : botAutomation.enabled
                            ? "Activadas"
                            : "Apagadas"}
                      </strong>
                    </div>
                    <div>
                      <span>Modo de prueba</span>
                      <strong>{state.testMode ? "Activo" : "Inactivo"}</strong>
                    </div>
                    <div>
                      <span>Números permitidos</span>
                      <strong>{String(state.testAllowedNumberCount)}</strong>
                    </div>
                    <div>
                      <span>Calidad</span>
                      <strong
                        class={`quality-rating quality-${state.whatsappQuality.toLowerCase()}`}
                      >
                        {state.whatsappQuality === "UNKNOWN"
                          ? "Sin verificar"
                          : state.whatsappQuality === "GREEN"
                            ? "Buena"
                            : state.whatsappQuality === "YELLOW"
                              ? "Revisar"
                              : "Con problemas"}
                      </strong>
                    </div>
                    <div>
                      <span>Envío de mensajes</span>
                      <strong
                        class={state.sendingPaused ? "sending-paused" : ""}
                      >
                        {state.sendingPaused ? "Pausados" : "Habilitados"}
                      </strong>
                    </div>
                  </div>
                  {botAutomation.enabled === false && (
                    <div class="settings-policy-alert">
                      <Icon name="info" size={18} />
                      <span>
                        <strong>
                          Las respuestas automáticas están apagadas
                        </strong>
                        <small>
                          Los mensajes seguirán llegando a Conversaciones para
                          que puedas responderlos de forma manual.
                        </small>
                      </span>
                    </div>
                  )}
                  {botAutomation.enabled === null && (
                    <div class="settings-policy-alert" role="alert">
                      <Icon name="alert" size={18} />
                      <span>
                        <strong>No pudimos comprobar el bot</strong>
                        <small>
                          Volvé a Inicio y reintentá antes de asumir que está
                          encendido o apagado.
                        </small>
                      </span>
                    </div>
                  )}
                  {state.testMode && state.testAllowedNumberCount === 0 && (
                    <div class="settings-policy-alert" role="alert">
                      <Icon name="alert" size={18} />
                      <span>
                        <strong>Todavía no se pueden enviar pruebas</strong>
                        <small>
                          Pedile a la persona que configuró WhatsApp que agregue
                          al menos un número de prueba.
                        </small>
                      </span>
                    </div>
                  )}
                  <div class="settings-button-row">
                    <button
                      class="secondary-button"
                      type="button"
                      disabled={!state.isAdmin}
                      title={
                        state.isAdmin
                          ? "Verificar la cuenta de WhatsApp"
                          : "Sólo una administradora puede verificar la conexión"
                      }
                      onClick$={async () => {
                        const { data, error } =
                          await getSupabaseClient().functions.invoke(
                            "whatsapp-health",
                            { method: "POST" },
                          );
                        if (error || !data) {
                          notice.value = "No pudimos probar la conexión.";
                          return;
                        }
                        state.whatsappStatus =
                          data.status === "connected"
                            ? "connected"
                            : data.status === "incomplete"
                              ? "incomplete"
                              : "error";
                        state.whatsappPhone = data.displayPhone ?? "";
                        state.whatsappName = data.displayName ?? "";
                        state.whatsappQuality = [
                          "GREEN",
                          "YELLOW",
                          "RED",
                          "UNKNOWN",
                        ].includes(data.qualityRating)
                          ? data.qualityRating
                          : "UNKNOWN";
                        state.sendingPaused = Boolean(data.sendingPaused);
                        state.sendingPauseReason =
                          data.sendingPauseReason ?? "";
                        state.testMode = data.safety?.testMode !== false;
                        state.testAllowedNumberCount = Number(
                          data.safety?.testAllowedNumberCount ?? 0,
                        );
                        notice.value = data.message || "Estado actualizado.";
                      }}
                    >
                      Verificar conexión
                    </button>
                    <Link class="secondary-button" href="/app/templates">
                      <Icon name="file" size={17} /> Mensajes para WhatsApp
                    </Link>
                  </div>
                  {state.isAdmin && (
                    <WhatsAppEmbeddedSignup isAdmin={state.isAdmin} />
                  )}
                </section>
              )}

              {tab.value === "users" && (
                <section class="settings-block">
                  <div>
                    <h2>Personas con acceso</h2>
                    <p>
                      Estas son las únicas personas que pueden entrar al
                      sistema.
                    </p>
                  </div>
                  {!state.isAdmin ? (
                    <p class="settings-note">
                      Esta sección está disponible únicamente para
                      administradores.
                    </p>
                  ) : (
                    <div class="settings-record-list">
                      {state.users.map((user) => (
                        <div key={user.id}>
                          <span>
                            <strong>{user.full_name}</strong>
                            <small>
                              {user.role === "ADMIN"
                                ? "Administradora"
                                : "Operadora"}
                            </small>
                          </span>
                          <span>{user.active ? "Activo" : "Inactivo"}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              )}
            </div>
          </div>
        )}
      </section>
      {notice.value && (
        <div
          class={{ toast: true, error: noticeIsError }}
          role={noticeIsError ? "alert" : "status"}
          aria-live={noticeIsError ? "assertive" : "polite"}
        >
          <span>{notice.value}</span>
          <button
            type="button"
            aria-label="Cerrar aviso"
            onClick$={() => (notice.value = "")}
          >
            ×
          </button>
        </div>
      )}
    </main>
  );
});

export const head: DocumentHead = { title: getPageTitle("Configuración") };
