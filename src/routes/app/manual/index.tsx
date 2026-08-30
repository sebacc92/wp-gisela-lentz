import {
  $,
  component$,
  useContext,
  useStore,
  useVisibleTask$,
} from "@qwik.dev/core";
import { Link, type DocumentHead, useNavigate } from "@qwik.dev/router";
import { AppNavigation } from "~/components/app/AppNavigation";
import { BOT_AUTOMATION_CONTEXT } from "~/components/app/BotAutomationContext";
import { ManualContent } from "~/components/manual/ManualContent";
import type { ManualSystemStatus } from "~/components/manual/SystemStatus";
import { Icon } from "~/components/ui/Icon";
import { isAdminProfile } from "~/lib/admin-access";
import {
  automationManualStatus,
  calendarManualStatus,
  testModeManualStatus,
  webhookManualStatus,
  whatsappManualStatus,
} from "~/lib/manual-status";
import { getPageTitle } from "~/config/business";
import { getSupabaseClient } from "~/lib/supabase/client";

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function safeCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function safeBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function safeTimestamp(value: unknown): string {
  if (typeof value !== "string" || value.length > 80) return "";
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : "";
}

function emptySystemStatus(): ManualSystemStatus {
  return {
    whatsapp: whatsappManualStatus({
      checked: false,
      accountPresent: false,
      connected: false,
      sendingPaused: true,
      attentionRequired: false,
      tokenExpired: false,
      pendingJobs: 0,
      ambiguousJobs: 0,
    }),
    automation: automationManualStatus(null),
    testMode: testModeManualStatus(null),
    calendar: calendarManualStatus({
      checked: false,
      configured: false,
      connected: false,
      status: "",
      pendingCount: 0,
      failedCount: 0,
    }),
    webhook: webhookManualStatus({
      checked: false,
      lastReceivedAt: "",
      failedCount: 0,
    }),
    lastWebhookAt: "",
    refreshedAt: "",
    loading: false,
    error: false,
  };
}

export default component$(() => {
  const navigate = useNavigate();
  const botAutomation = useContext(BOT_AUTOMATION_CONTEXT);
  const access = useStore({ loading: true, allowed: false, failed: false });
  const system = useStore<ManualSystemStatus>(emptySystemStatus());

  const refreshSystemStatus = $(async () => {
    system.loading = true;
    system.error = false;
    try {
      const client = getSupabaseClient();
      const [signupResult, calendarResult] = await Promise.all([
        client.functions.invoke("whatsapp-embedded-signup", {
          method: "POST",
          body: { action: "manual_status" },
        }),
        // This endpoint reads local connection state only. It does not query
        // Google or Meta from the Manual page.
        client.functions.invoke("google-calendar-status", {
          method: "POST",
          body: { action: "manual_status" },
        }),
      ]);

      const signup = record(signupResult.data);
      const whatsappChecked = !signupResult.error && signup !== null;
      const pendingJobs = safeCount(signup?.pendingJobs);
      const ambiguousJobs = safeCount(signup?.ambiguousJobs);
      const accountPresent = safeBoolean(signup?.accountPresent);
      const whatsappConnected = safeBoolean(signup?.connected);
      const sendingPaused = safeBoolean(signup?.sendingPaused);
      const attentionRequired = safeBoolean(signup?.attentionRequired);
      const tokenExpired = safeBoolean(signup?.tokenExpired);
      const lastWebhookFromStatus = safeTimestamp(signup?.lastWebhookAt);
      const webhookChecked = signup?.lastWebhookChecked === true;
      const failedWebhooks = safeCount(signup?.recentWebhookFailures);
      const displayedWebhookAt =
        whatsappChecked && webhookChecked ? lastWebhookFromStatus : "";

      const calendar = record(calendarResult.data);
      const calendarChecked = !calendarResult.error && calendar !== null;
      const calendarConfigured = safeBoolean(calendar?.configured);
      const calendarConnected = safeBoolean(calendar?.connected);
      const calendarStatus =
        typeof calendar?.status === "string" ? calendar.status : null;
      const calendarPending = safeCount(calendar?.pendingCount);
      const calendarFailed = safeCount(calendar?.failedCount);

      const next: ManualSystemStatus = {
        whatsapp: whatsappManualStatus({
          checked: whatsappChecked,
          accountPresent,
          connected: whatsappConnected,
          sendingPaused,
          attentionRequired,
          tokenExpired,
          pendingJobs,
          ambiguousJobs,
        }),
        automation: automationManualStatus(botAutomation.enabled),
        testMode: testModeManualStatus(
          whatsappChecked && typeof signup?.testMode === "boolean"
            ? signup.testMode
            : null,
        ),
        calendar: calendarManualStatus({
          checked: calendarChecked,
          configured: calendarConfigured,
          connected: calendarConnected,
          status: calendarStatus,
          pendingCount: calendarPending,
          failedCount: calendarFailed,
        }),
        webhook: webhookManualStatus({
          checked: whatsappChecked && webhookChecked,
          lastReceivedAt: displayedWebhookAt,
          failedCount: failedWebhooks,
        }),
        lastWebhookAt: displayedWebhookAt,
        refreshedAt: new Date().toISOString(),
        loading: false,
        error:
          !whatsappChecked ||
          accountPresent === null ||
          (accountPresent &&
            (whatsappConnected === null ||
              sendingPaused === null ||
              attentionRequired === null ||
              tokenExpired === null ||
              pendingJobs === null ||
              ambiguousJobs === null)) ||
          !calendarChecked ||
          calendarConfigured === null ||
          (calendarConfigured &&
            (calendarConnected === null ||
              calendarStatus === null ||
              calendarPending === null ||
              calendarFailed === null)) ||
          !webhookChecked ||
          failedWebhooks === null ||
          botAutomation.enabled === null,
      };
      Object.assign(system, next);
    } catch {
      Object.assign(system, {
        ...emptySystemStatus(),
        refreshedAt: new Date().toISOString(),
        error: true,
      });
    } finally {
      system.loading = false;
    }
  });

  // eslint-disable-next-line qwik/no-use-visible-task
  useVisibleTask$(async () => {
    try {
      const client = getSupabaseClient();
      const {
        data: { user },
      } = await client.auth.getUser();
      if (!user) {
        await navigate("/login");
        return;
      }
      const { data: profile, error } = await client
        .from("profiles")
        .select("role,active")
        .eq("id", user.id)
        .maybeSingle();
      if (error || !isAdminProfile(profile)) {
        access.failed = true;
        return;
      }
      access.allowed = true;
      await refreshSystemStatus();
    } catch {
      access.failed = true;
    } finally {
      access.loading = false;
    }
  });

  return (
    <main class="section-shell">
      <AppNavigation active="manual" />
      <section id="app-content" class="section-page manual-page" tabIndex={-1}>
        {access.loading ? (
          <div class="section-empty" aria-live="polite">
            <span class="small-spinner" aria-hidden="true" />
            <p>Comprobando el acceso al Manual…</p>
          </div>
        ) : !access.allowed ? (
          <div class="section-empty" role="alert">
            <Icon name="alert" size={25} />
            <strong>Este Manual es solo para administración.</strong>
            <p>
              Si necesitás ayuda para una tarea diaria, consultá a una
              administradora.
            </p>
            <Link class="secondary-button" href="/app">
              Volver al inicio
            </Link>
          </div>
        ) : (
          <>
            <header class="section-page-header manual-header">
              <div>
                <span class="eyebrow">Administración</span>
                <h1>Manual del consultorio</h1>
                <p>
                  Una guía simple para atender mensajes, organizar turnos y
                  saber qué revisar cuando algo necesita atención.
                </p>
              </div>
              <Link class="secondary-button" href="/app/settings">
                Ir a configuración
              </Link>
            </header>
            <ManualContent
              systemStatus={{
                ...system,
                automation: automationManualStatus(botAutomation.enabled),
              }}
              onRefreshSystemStatus$={refreshSystemStatus}
            />
          </>
        )}
      </section>
    </main>
  );
});

export const head: DocumentHead = { title: getPageTitle("Manual") };
