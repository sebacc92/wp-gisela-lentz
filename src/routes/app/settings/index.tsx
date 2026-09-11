import {
  $,
  component$,
  useContextProvider,
  useSignal,
  useStore,
  useVisibleTask$,
} from "@qwik.dev/core";
import { type DocumentHead, useLocation } from "@qwik.dev/router";
import { AppNavigation } from "~/components/app/AppNavigation";
import { ManualHelpLink } from "~/components/app/ManualHelpLink";
import { AppointmentsSettings } from "~/components/settings/AppointmentsSettings";
import { AuditLogSettings } from "~/components/settings/AuditLogSettings";
import { AutomationSettings } from "~/components/settings/AutomationSettings";
import { BookingSettings } from "~/components/settings/BookingSettings";
import { GoogleCalendarSettings } from "~/components/settings/GoogleCalendarSettings";
import { HoursSettings } from "~/components/settings/HoursSettings";
import { OfficeSettings } from "~/components/settings/OfficeSettings";
import { RemindersSettings } from "~/components/settings/RemindersSettings";
import { SETTINGS_CONTEXT } from "~/components/settings/SettingsContext";
import { UsersSettings } from "~/components/settings/UsersSettings";
import { WhatsAppSettings } from "~/components/settings/WhatsAppSettings";
import { cleanTime } from "~/components/settings/settings-format";
import type {
  BlockRow,
  ProfileRow,
  RuleRow,
  ServiceRow,
  SettingsState,
  SettingsTab,
  SettingsTabOption,
} from "~/components/settings/settings-types";
import { Icon } from "~/components/ui/Icon";
import { BUSINESS_CONFIG, getPageTitle } from "~/config/business";
import { getSupabaseClient } from "~/lib/supabase/client";

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
  audit: "audit",
  logs: "audit",
  registro: "audit",
  actividad: "audit",
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
  { key: "audit", label: "Registro de actividad" },
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

/**
 * Cáscara de Configuración.
 *
 * No dibuja ninguna sección: carga el estado compartido, lo publica en
 * `SETTINGS_CONTEXT` y monta la pestaña activa. Cada sección vive en su propio
 * componente bajo `~/components/settings`, así tocar los recordatorios no
 * obliga a abrir la pantalla entera.
 *
 * Sólo se monta la pestaña visible: la de Google Calendar consulta su estado
 * al abrirse y lo suelta al cerrarse, en lugar de mantenerlo vivo siempre.
 */
export default component$(() => {
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
  const state = useStore<SettingsState>({
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

  useContextProvider(SETTINGS_CONTEXT, {
    state,
    notice,
    reload$: loadSettings,
    saveAppSettings$: saveAppSettings,
  });

  // eslint-disable-next-line qwik/no-use-visible-task
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
    await loadSettings();
  });

  const selectTab = $((nextTab: SettingsTab) => {
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
  });

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
                onChange$={(_, element) =>
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

              {tab.value === "booking" && <BookingSettings />}
              {tab.value === "office" && <OfficeSettings />}
              {tab.value === "hours" && <HoursSettings />}
              {tab.value === "appointments" && <AppointmentsSettings />}
              {tab.value === "google" && <GoogleCalendarSettings />}
              {tab.value === "reminders" && <RemindersSettings />}
              {tab.value === "automation" && <AutomationSettings />}
              {tab.value === "whatsapp" && <WhatsAppSettings />}
              {tab.value === "users" && <UsersSettings />}
              {tab.value === "audit" && <AuditLogSettings />}
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
