import {
  $,
  component$,
  noSerialize,
  type NoSerialize,
  useSignal,
  useStore,
  useVisibleTask$,
} from "@qwik.dev/core";
import { Icon } from "~/components/ui/Icon";
import { BUSINESS_CONFIG } from "~/config/business";
import { getSupabaseClient } from "~/lib/supabase/client";
import {
  bindEmbeddedSignupMessageSource,
  cancelEmbeddedSignupSessionFailClosed,
  embeddedSignupHandshakeComplete,
  effectiveEmbeddedSignupTokenExpiry,
  embeddedSignupLoginOptions,
  embeddedSignupAccountRequiresResolution,
  embeddedSignupSessionAcceptsCallback,
  embeddedSignupStartAllowed,
  embeddedSignupTabAlreadyAttempted,
  facebookSdkInitialization,
  FACEBOOK_JAVASCRIPT_SDK_URL,
  historySharingDecisionForNewAttempt,
  initialEmbeddedSignupHandshake,
  onboardingAttemptBlocksStart,
  parseEmbeddedSignupStartConfiguration,
  parseFacebookLoginCode,
  parseWhatsAppEmbeddedSignupMessage,
  reduceEmbeddedSignupHandshake,
  reserveEmbeddedSignupTabAttempt,
  WHATSAPP_BUSINESS_APP_FINISH_EVENT,
  type EmbeddedSignupFinishEvent,
  type EmbeddedSignupHandshakeAction,
  type EmbeddedSignupHandshakeState,
  type EmbeddedSignupStartConfiguration,
  type FacebookJavascriptSdk,
  type HistorySharingDecision,
} from "~/lib/whatsapp-embedded-signup";

type EmbeddedSignupAction =
  | "status"
  | "start"
  | "exchange"
  | "finish"
  | "cancel"
  | "offboard";

type UnknownRecord = Record<string, unknown>;

interface EmbeddedSignupStatusView {
  enabled: boolean;
  configured: boolean;
  onboardingState: string;
  attemptId: string;
  onboardingStartedAt: string;
  onboardingExpiresAt: string;
  onboardingLastError: string;
  accountId: string;
  accountOnboardingStatus: string;
  tokenConfigured: boolean;
  requiresOffboarding: boolean;
  tokenStatus: string;
  tokenValidationStatus: string;
  tokenLastValidatedAt: string;
  tokenValidationDueAt: string;
  attentionRequired: boolean;
  attentionReason: string;
  lastDisconnectionReason: string;
  lastDisconnectionInitiatedBy: string;
  tokenExpiresAt: string;
  tokenDataAccessExpiresAt: string;
  tokenEffectiveExpiresAt: string;
  tokenExpired: boolean;
  connected: boolean;
  wabaId: string;
  phoneNumberId: string;
  displayPhone: string;
  onboardedAt: string;
  subscriptionStatus: string;
  contactsStatus: string;
  historyStatus: string;
  historyDecision: HistorySharingDecision | "pending";
  syncDeadlineAt: string;
  syncAtRisk: boolean;
  accountLastError: string;
  automationsEnabled: boolean;
  sendingPaused: boolean;
}

interface ActiveEmbeddedSignupSession {
  attemptId: string;
  state: string;
  nonce: string;
  expiresAtMs: number;
  historyDecision: HistorySharingDecision;
  handshake: EmbeddedSignupHandshakeState;
  listener: (event: MessageEvent) => void;
  timeoutId: number;
  closing: boolean;
  lifecycleState: "active" | "cancelling" | "offboarding";
  messageSource: MessageEventSource | null;
}

interface WhatsAppEmbeddedSignupProps {
  isAdmin: boolean;
}

declare global {
  interface Window {
    FB?: FacebookJavascriptSdk;
  }
}

let facebookSdkPromise: Promise<FacebookJavascriptSdk> | undefined;
let initializedFacebookAppId: string | undefined;

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function text(value: unknown, maximum = 240): string {
  if (typeof value !== "string") return "";
  const clean = value.trim();
  const hasControlCharacter = Array.from(clean).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
  return clean.length <= maximum && !hasControlCharacter ? clean : "";
}

function safeErrorCode(value: unknown): string {
  const code = text(value, 100).toUpperCase();
  return /^[A-Z0-9_.:-]{2,100}$/.test(code) ? code : "";
}

function bool(value: unknown): boolean {
  return value === true;
}

function statusView(value: unknown): EmbeddedSignupStatusView {
  const root = record(value) ?? {};
  const onboarding = record(root.onboarding) ?? {};
  const account = record(root.account) ?? {};
  const decision = text(account.historyDecision, 20);
  const tokenExpiresAt = text(account.tokenExpiresAt, 80);
  const tokenDataAccessExpiresAt = text(account.tokenDataAccessExpiresAt, 80);
  return {
    enabled: root.enabled === true,
    configured: root.configured === true,
    onboardingState: text(onboarding.state, 80) || "not_started",
    attemptId: text(onboarding.attemptId, 200),
    onboardingStartedAt: text(onboarding.startedAt, 80),
    onboardingExpiresAt: text(onboarding.expiresAt, 80),
    onboardingLastError: safeErrorCode(onboarding.lastError),
    accountId: text(account.id ?? account.accountId, 200),
    accountOnboardingStatus:
      text(account.onboardingStatus, 80) || "not_started",
    tokenConfigured: bool(account.tokenConfigured),
    requiresOffboarding: bool(account.requiresOffboarding),
    tokenStatus: text(account.tokenStatus, 80) || "missing",
    tokenValidationStatus: text(account.tokenValidationStatus, 80) || "missing",
    tokenLastValidatedAt: text(account.tokenLastValidatedAt, 80),
    tokenValidationDueAt: text(account.tokenValidationDueAt, 80),
    attentionRequired: bool(account.attentionRequired),
    attentionReason: safeErrorCode(account.attentionReason),
    lastDisconnectionReason: safeErrorCode(account.lastDisconnectionReason),
    lastDisconnectionInitiatedBy: safeErrorCode(
      account.lastDisconnectionInitiatedBy,
    ),
    tokenExpiresAt,
    tokenDataAccessExpiresAt,
    tokenEffectiveExpiresAt: effectiveEmbeddedSignupTokenExpiry({
      tokenExpiresAt,
      tokenDataAccessExpiresAt,
    }),
    tokenExpired: bool(account.tokenExpired),
    connected: bool(account.connected),
    wabaId: text(account.wabaId, 64),
    phoneNumberId: text(account.phoneNumberId, 64),
    displayPhone: text(account.displayPhone, 80),
    onboardedAt: text(account.onboardedAt, 80),
    subscriptionStatus: text(account.subscriptionStatus, 80) || "not_started",
    contactsStatus: text(account.contactsStatus, 80) || "not_started",
    historyStatus: text(account.historyStatus, 80) || "not_started",
    historyDecision:
      decision === "accepted" || decision === "declined" ? decision : "pending",
    syncDeadlineAt: text(account.syncDeadlineAt, 80),
    syncAtRisk: bool(account.syncAtRisk),
    accountLastError: safeErrorCode(account.lastError),
    automationsEnabled: root.automationsEnabled === true,
    sendingPaused: root.sendingPaused === true,
  };
}

async function invokeEmbeddedSignup(
  action: EmbeddedSignupAction,
  payload: UnknownRecord = {},
): Promise<UnknownRecord> {
  const { data, error } = await getSupabaseClient().functions.invoke(
    "whatsapp-embedded-signup",
    {
      method: "POST",
      body: { action, ...payload },
    },
  );
  const result = record(data);
  if (error || !result || result.error) {
    throw new Error(`WHATSAPP_EMBEDDED_SIGNUP_${action.toUpperCase()}_FAILED`);
  }
  return result;
}

function loadFacebookSdk(): Promise<FacebookJavascriptSdk> {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return Promise.reject(new Error("FACEBOOK_SDK_BROWSER_REQUIRED"));
  }
  if (window.FB) return Promise.resolve(window.FB);
  if (facebookSdkPromise) return facebookSdkPromise;

  facebookSdkPromise = new Promise<FacebookJavascriptSdk>((resolve, reject) => {
    const existing = document.getElementById("facebook-jssdk");
    if (
      existing instanceof HTMLScriptElement &&
      existing.src !== FACEBOOK_JAVASCRIPT_SDK_URL
    ) {
      reject(new Error("FACEBOOK_SDK_SOURCE_CONFLICT"));
      return;
    }

    const script =
      existing instanceof HTMLScriptElement
        ? existing
        : document.createElement("script");
    let timeoutId = 0;
    const cleanup = () => {
      window.clearTimeout(timeoutId);
      script.removeEventListener("load", loaded);
      script.removeEventListener("error", failed);
    };
    const loaded = () => {
      cleanup();
      if (window.FB) resolve(window.FB);
      else reject(new Error("FACEBOOK_SDK_GLOBAL_MISSING"));
    };
    const failed = () => {
      cleanup();
      reject(new Error("FACEBOOK_SDK_LOAD_FAILED"));
    };

    script.addEventListener("load", loaded, { once: true });
    script.addEventListener("error", failed, { once: true });
    timeoutId = window.setTimeout(failed, 15_000);

    if (!existing) {
      script.id = "facebook-jssdk";
      script.src = FACEBOOK_JAVASCRIPT_SDK_URL;
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    }
  }).catch((error) => {
    facebookSdkPromise = undefined;
    throw error;
  });
  return facebookSdkPromise;
}

function formatDate(value: string): string {
  if (!value) return "Todavía no disponible";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Todavía no disponible";
  return new Intl.DateTimeFormat("es-AR", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: BUSINESS_CONFIG.timezone,
  }).format(date);
}

function statusLabel(value: string): string {
  const labels: Record<string, string> = {
    active: "Activo",
    cancelled: "Cancelado",
    completed: "Completado",
    connected: "Conectado",
    declined: "No solicitado",
    disconnected: "Desconectado",
    error: "Con error",
    failed: "Con error",
    idle: "Sin iniciar",
    in_progress: "En proceso",
    not_started: "Sin iniciar",
    onboarding: "En incorporación",
    partial: "Parcial",
    pending: "Pendiente",
    processing: "En proceso",
    subscribed: "Suscripta",
    succeeded: "Completado",
  };
  return labels[value.toLowerCase()] ?? "En revisión";
}

function finishPayload(message: EmbeddedSignupFinishEvent): UnknownRecord {
  const { assets } = message;
  return {
    type: message.type,
    event: WHATSAPP_BUSINESS_APP_FINISH_EVENT,
    version: message.version,
    wabaId: assets.wabaId,
    ...(assets.phoneNumberId ? { phoneNumberId: assets.phoneNumberId } : {}),
    ...(assets.businessPortfolioId
      ? { businessPortfolioId: assets.businessPortfolioId }
      : {}),
    assetIds: {
      adAccountIds: assets.adAccountIds,
      pageIds: assets.pageIds,
      datasetIds: assets.datasetIds,
      catalogIds: assets.catalogIds,
      instagramAccountIds: assets.instagramAccountIds,
      wabaIds: assets.wabaIds,
    },
  };
}

export const WhatsAppEmbeddedSignup = component$<WhatsAppEmbeddedSignupProps>(
  ({ isAdmin }) => {
    const status = useStore<EmbeddedSignupStatusView>(statusView(null));
    const historyAccepted = useSignal(false);
    const loadingStatus = useSignal(true);
    const action = useSignal<
      "" | "start" | "exchange" | "finish" | "cancel" | "offboard"
    >();
    const message = useSignal("");
    const error = useSignal(false);
    const tabAttemptLocked = useSignal(false);
    const activeSession = useSignal<
      NoSerialize<ActiveEmbeddedSignupSession> | undefined
    >();

    const replaceStatus = $((next: EmbeddedSignupStatusView) => {
      Object.assign(status, next);
    });

    const refreshStatus = $(async () => {
      if (!isAdmin) return;
      loadingStatus.value = true;
      try {
        await replaceStatus(statusView(await invokeEmbeddedSignup("status")));
      } catch {
        error.value = true;
        message.value =
          "No pudimos consultar el estado de incorporación de WhatsApp.";
      } finally {
        loadingStatus.value = false;
      }
    });

    const releaseSession = $((session: ActiveEmbeddedSignupSession) => {
      window.removeEventListener("message", session.listener);
      window.clearTimeout(session.timeoutId);
      if (activeSession.value === session) activeSession.value = undefined;
    });

    const finishIfComplete = $(async (session: ActiveEmbeddedSignupSession) => {
      if (!embeddedSignupHandshakeComplete(session.handshake)) return;
      await releaseSession(session);
      action.value = "";
      error.value = false;
      message.value =
        "Meta recibió la conexión. Estamos validando los activos e iniciando la sincronización segura.";
      await refreshStatus();
    });

    const dispatchHandshake = $(
      async (
        session: ActiveEmbeddedSignupSession,
        nextAction: EmbeddedSignupHandshakeAction,
      ) => {
        if (
          !embeddedSignupSessionAcceptsCallback({
            activeSessionMatches: activeSession.value === session,
            closing: session.closing,
            expiresAtMs: session.expiresAtMs,
            sessionLifecycleState: session.lifecycleState,
          })
        ) {
          return;
        }
        const transition = reduceEmbeddedSignupHandshake(
          session.handshake,
          nextAction,
        );
        session.handshake = transition.state;

        for (const effect of transition.effects) {
          if (effect.type === "exchange") {
            action.value = "exchange";
            const assets = effect.finish ? finishPayload(effect.finish) : {};
            try {
              await invokeEmbeddedSignup("exchange", {
                attemptId: session.attemptId,
                state: session.state,
                nonce: session.nonce,
                code: effect.code,
                historyDecision: session.historyDecision,
                ...assets,
              });
              if (
                !embeddedSignupSessionAcceptsCallback({
                  activeSessionMatches: activeSession.value === session,
                  closing: session.closing,
                  expiresAtMs: session.expiresAtMs,
                  sessionLifecycleState: session.lifecycleState,
                })
              ) {
                return;
              }
              session.handshake = reduceEmbeddedSignupHandshake(
                session.handshake,
                { type: "exchange_acknowledged" },
              ).state;
              await finishIfComplete(session);
              if (activeSession.value === session) action.value = "";
            } catch {
              action.value = "";
              error.value = true;
              message.value =
                "No pudimos intercambiar el código dentro de la ventana segura. Cancelá este intento antes de volver a empezar.";
            }
            continue;
          }

          action.value = "finish";
          try {
            await invokeEmbeddedSignup("finish", {
              attemptId: session.attemptId,
              state: session.state,
              nonce: session.nonce,
              historyDecision: session.historyDecision,
              ...finishPayload(effect.message),
            });
            if (
              !embeddedSignupSessionAcceptsCallback({
                activeSessionMatches: activeSession.value === session,
                closing: session.closing,
                expiresAtMs: session.expiresAtMs,
                sessionLifecycleState: session.lifecycleState,
              })
            ) {
              return;
            }
            session.handshake = reduceEmbeddedSignupHandshake(
              session.handshake,
              {
                type: "finish_acknowledged",
              },
            ).state;
            await finishIfComplete(session);
            if (activeSession.value === session) action.value = "";
          } catch {
            action.value = "";
            error.value = true;
            message.value =
              "Meta completó la ventana, pero no pudimos guardar el resultado. Cancelá este intento antes de volver a empezar.";
          }
        }
      },
    );

    const cancelAttempt = $(
      async (
        attemptId?: string,
        reason:
          | "USER_CANCELLED"
          | "META_CANCELLED"
          | "META_ERROR" = "USER_CANCELLED",
      ) => {
        const session = activeSession.value;
        const targetAttemptId =
          attemptId || session?.attemptId || status.attemptId;
        if (!targetAttemptId || action.value === "cancel") return;
        action.value = "cancel";
        const cancellation = await cancelEmbeddedSignupSessionFailClosed({
          session,
          releaseSession: async () => {
            if (session) await releaseSession(session);
          },
          requestCancellation: () =>
            invokeEmbeddedSignup("cancel", {
              attemptId: targetAttemptId,
              reason,
            }),
          reconcileStatus: refreshStatus,
        });
        if (cancellation.outcome === "cancelled") {
          error.value = false;
          message.value =
            "El intento incompleto fue cancelado de forma segura.";
        } else if (cancellation.outcome === "not_cancelled") {
          error.value = false;
          message.value =
            "El intento ya había cambiado de estado. Actualizamos el estado real y mantuvimos cerrada esta sesión de Meta.";
        } else {
          error.value = true;
          message.value =
            "No pudimos confirmar la cancelación. La sesión de Meta quedó cerrada; actualizá el estado antes de continuar.";
        }
        action.value = "";
      },
    );

    const startOnboarding = $(async () => {
      const blockingAttempt = onboardingAttemptBlocksStart({
        attemptId: status.attemptId,
        state: status.onboardingState,
      });
      const partialAccount = embeddedSignupAccountRequiresResolution({
        hasAccount: Boolean(status.accountId),
        requiresOffboarding: status.requiresOffboarding,
        tokenConfigured: status.tokenConfigured,
        onboardingStatus: status.accountOnboardingStatus,
      });
      if (
        !embeddedSignupStartAllowed({
          isAdmin,
          enabled: status.enabled,
          configured: status.configured,
          actionInProgress: Boolean(action.value),
          tabAttemptLocked: tabAttemptLocked.value,
          connected: status.connected,
          partialAccount,
          automationsEnabled: status.automationsEnabled,
          blockingAttempt,
        })
      ) {
        return;
      }

      if (!reserveEmbeddedSignupTabAttempt(window.sessionStorage)) {
        tabAttemptLocked.value = true;
        error.value = true;
        message.value =
          "Esta pestaña ya inició Embedded Signup. Cerrá esta pestaña y cualquier ventana de Meta; después abrí el panel en una pestaña nueva para reintentar de forma segura.";
        return;
      }
      tabAttemptLocked.value = true;

      action.value = "start";
      error.value = false;
      message.value = "";
      const historyDecision = historySharingDecisionForNewAttempt(
        historyAccepted.value,
      );
      let configuration: EmbeddedSignupStartConfiguration | null = null;
      try {
        const response = await invokeEmbeddedSignup("start", {
          historyDecision,
        });
        configuration = parseEmbeddedSignupStartConfiguration(response);
        if (!configuration) throw new Error("INVALID_START_CONFIGURATION");

        const sdk = await loadFacebookSdk();
        if (
          initializedFacebookAppId &&
          initializedFacebookAppId !== configuration.appId
        ) {
          throw new Error("FACEBOOK_APP_ID_CHANGED");
        }
        sdk.init(
          facebookSdkInitialization(
            configuration.appId,
            configuration.sdkVersion,
          ),
        );
        initializedFacebookAppId = configuration.appId;

        const session: ActiveEmbeddedSignupSession = {
          attemptId: configuration.attemptId,
          state: configuration.state,
          nonce: configuration.nonce,
          expiresAtMs: new Date(configuration.expiresAt).getTime(),
          historyDecision,
          handshake: initialEmbeddedSignupHandshake(),
          listener: () => undefined,
          timeoutId: 0,
          closing: false,
          lifecycleState: "active",
          messageSource: null,
        };
        session.listener = (event: MessageEvent) => {
          if (
            !embeddedSignupSessionAcceptsCallback({
              activeSessionMatches: activeSession.value === session,
              closing: session.closing,
              expiresAtMs: session.expiresAtMs,
              sessionLifecycleState: session.lifecycleState,
            })
          ) {
            return;
          }
          const parsed = parseWhatsAppEmbeddedSignupMessage({
            origin: event.origin,
            data: event.data,
          });
          if (!parsed.accepted) {
            if (
              parsed.reason !== "UNRELATED_MESSAGE" &&
              parsed.reason !== "UNTRUSTED_ORIGIN"
            ) {
              error.value = true;
              message.value =
                "Meta envió una respuesta que no coincide con Embedded Signup v4.";
            }
            return;
          }
          const sourceBinding = bindEmbeddedSignupMessageSource(
            session.messageSource,
            event.source,
          );
          if (!sourceBinding.accepted) return;
          session.messageSource = sourceBinding.source;
          if (parsed.message.kind === "finish") {
            void dispatchHandshake(session, {
              type: "finish_received",
              message: parsed.message,
            });
            return;
          }
          error.value =
            parsed.message.kind === "error" || parsed.message.hasError;
          message.value = error.value
            ? "Meta informó un error y el intento fue cancelado."
            : "El onboarding fue cancelado antes de completarse.";
          void cancelAttempt(
            session.attemptId,
            error.value ? "META_ERROR" : "META_CANCELLED",
          );
        };

        activeSession.value = noSerialize(session);
        window.addEventListener("message", session.listener);
        session.timeoutId = window.setTimeout(
          () => {
            if (activeSession.value !== session || session.closing) return;
            error.value = true;
            message.value =
              "La sesión de incorporación venció. Cancelamos el intento para que ningún código pueda reutilizarse.";
            void cancelAttempt(session.attemptId);
          },
          Math.max(1, session.expiresAtMs - Date.now()),
        );

        sdk.login((response) => {
          if (
            !embeddedSignupSessionAcceptsCallback({
              activeSessionMatches: activeSession.value === session,
              closing: session.closing,
              expiresAtMs: session.expiresAtMs,
              sessionLifecycleState: session.lifecycleState,
            })
          ) {
            return;
          }
          const code = parseFacebookLoginCode(response);
          if (!code) {
            error.value = true;
            message.value =
              "Meta no devolvió un código intercambiable. El intento será cancelado.";
            void cancelAttempt(session.attemptId);
            return;
          }
          // The code is passed directly into the one-shot transition and is
          // never assigned to a signal, store, URL or browser storage.
          void dispatchHandshake(session, {
            type: "code_received",
            code,
          });
        }, embeddedSignupLoginOptions(configuration.configurationId));
        if (action.value === "start") action.value = "";
        message.value =
          "Completá la ventana de Meta. El código se enviará al backend apenas sea emitido.";
      } catch {
        const session = activeSession.value;
        if (session) {
          session.closing = true;
          await releaseSession(session);
        }
        error.value = true;
        message.value =
          "No pudimos abrir Embedded Signup de forma segura. El intento quedó incompleto y debe cancelarse antes de reintentar.";
        if (configuration?.attemptId) {
          try {
            await invokeEmbeddedSignup("cancel", {
              attemptId: configuration.attemptId,
            });
            await refreshStatus();
          } catch {
            // Keep the explicit incomplete warning. Never expose raw provider
            // or backend errors, public configuration, state or nonce.
          }
        }
      } finally {
        if (!activeSession.value) action.value = "";
      }
    });

    const offboard = $(async () => {
      if (!isAdmin || !status.accountId || action.value) return;
      if (
        !window.confirm(
          "¿Querés retirar la integración técnica? Se desuscribirán los webhooks y se retirará la credencial local; esto no desconecta Coexistence en WhatsApp Business App. Los mensajes importados se conservarán.",
        )
      ) {
        return;
      }
      const session = activeSession.value;
      if (session) {
        session.closing = true;
        session.lifecycleState = "offboarding";
        await releaseSession(session);
      }
      action.value = "offboard";
      error.value = false;
      message.value = "";
      try {
        await invokeEmbeddedSignup("offboard", { accountId: status.accountId });
        message.value =
          "El retiro técnico quedó en proceso. La credencial se eliminará sólo después de reconciliar la suscripción; la desconexión real de Coexistence se hace desde WhatsApp Business App.";
        await refreshStatus();
      } catch {
        error.value = true;
        message.value =
          "No pudimos completar el offboarding. La cuenta quedó bloqueada para revisión.";
      } finally {
        action.value = "";
      }
    });

    // This integration must initialize only after the admin UI is visible in
    // a browser; SSR must not load Meta's SDK or access window.
    // eslint-disable-next-line qwik/no-use-visible-task
    useVisibleTask$(({ cleanup }) => {
      if (isAdmin) {
        tabAttemptLocked.value = embeddedSignupTabAlreadyAttempted(
          window.sessionStorage,
        );
        void refreshStatus();
      }
      cleanup(() => {
        const session = activeSession.value;
        if (!session) return;
        window.removeEventListener("message", session.listener);
        window.clearTimeout(session.timeoutId);
        activeSession.value = undefined;
      });
    });

    if (!isAdmin) return null;

    const blockingAttempt =
      Boolean(activeSession.value) ||
      onboardingAttemptBlocksStart({
        attemptId: status.attemptId,
        state: status.onboardingState,
      });
    const partialAccount = embeddedSignupAccountRequiresResolution({
      hasAccount: Boolean(status.accountId),
      requiresOffboarding: status.requiresOffboarding,
      tokenConfigured: status.tokenConfigured,
      onboardingStatus: status.accountOnboardingStatus,
    });
    const lastError = status.accountLastError || status.onboardingLastError;
    const canStart = embeddedSignupStartAllowed({
      isAdmin,
      enabled: status.enabled,
      configured: status.configured,
      actionInProgress: Boolean(action.value),
      tabAttemptLocked: tabAttemptLocked.value,
      connected: status.connected,
      partialAccount,
      automationsEnabled: status.automationsEnabled,
      blockingAttempt,
    });

    return (
      <div
        class="whatsapp-embedded-signup"
        aria-labelledby="whatsapp-signup-title"
      >
        <div class="whatsapp-embedded-signup-heading">
          <span class="whatsapp-embedded-signup-icon">
            <Icon name="message" size={22} />
          </span>
          <div>
            <h3 id="whatsapp-signup-title">Conectar WhatsApp Business</h3>
            <p>
              Incorporá la app del teléfono mediante Coexistence sin habilitar
              respuestas automáticas.
            </p>
          </div>
          <button
            class="secondary-button whatsapp-signup-refresh"
            type="button"
            disabled={loadingStatus.value || Boolean(action.value)}
            onClick$={() => refreshStatus()}
          >
            {loadingStatus.value ? "Consultando…" : "Actualizar estado"}
          </button>
        </div>

        {loadingStatus.value ? (
          <div class="whatsapp-signup-loading" role="status" aria-live="polite">
            <span class="small-spinner" />
            <span>Comprobando Coexistence…</span>
          </div>
        ) : (
          <dl class="whatsapp-signup-status-grid">
            <div>
              <dt>Coexistence</dt>
              <dd>
                {statusLabel(
                  partialAccount
                    ? status.accountOnboardingStatus
                    : status.onboardingState,
                )}
              </dd>
            </div>
            <div>
              <dt>WABA</dt>
              <dd>
                {status.accountId
                  ? status.wabaId || "Conectada"
                  : "Sin conectar"}
              </dd>
            </div>
            <div>
              <dt>Número</dt>
              <dd>
                {status.displayPhone || status.phoneNumberId || "Sin conectar"}
              </dd>
            </div>
            <div>
              <dt>Contactos</dt>
              <dd>{statusLabel(status.contactsStatus)}</dd>
            </div>
            <div>
              <dt>Historial</dt>
              <dd>
                {status.historyDecision === "declined"
                  ? "No solicitado"
                  : statusLabel(status.historyStatus)}
              </dd>
            </div>
            <div>
              <dt>Onboarding completado</dt>
              <dd>{formatDate(status.onboardedAt)}</dd>
            </div>
            <div>
              <dt>Vencimiento efectivo de credencial</dt>
              <dd>
                {status.tokenEffectiveExpiresAt
                  ? formatDate(status.tokenEffectiveExpiresAt)
                  : "Sin vencimiento informado"}
                {status.tokenDataAccessExpiresAt &&
                  status.tokenEffectiveExpiresAt ===
                    status.tokenDataAccessExpiresAt && (
                    <small>Incluye el límite de acceso a datos de Meta</small>
                  )}
              </dd>
            </div>
            <div>
              <dt>Suscripción de la app</dt>
              <dd>{statusLabel(status.subscriptionStatus)}</dd>
            </div>
            <div>
              <dt>Deadline de sincronización</dt>
              <dd>{formatDate(status.syncDeadlineAt)}</dd>
            </div>
          </dl>
        )}

        <div
          class={{
            "whatsapp-signup-automation-lock": true,
            danger: status.automationsEnabled,
          }}
          role={status.automationsEnabled ? "alert" : "status"}
        >
          <Icon
            name={status.automationsEnabled ? "alert" : "check-circle"}
            size={18}
          />
          <span>
            <strong>
              {status.automationsEnabled
                ? "Las automatizaciones deben apagarse antes de continuar"
                : "Automatizaciones desactivadas durante la incorporación"}
            </strong>
            <small>
              Embedded Signup no activa el bot ni envía mensajes a Graph.
            </small>
          </span>
        </div>

        {status.syncAtRisk && (
          <div class="settings-policy-alert" role="alert">
            <Icon name="alert" size={18} />
            <span>
              <strong>La ventana de sincronización necesita atención</strong>
              <small>
                No vuelvas a iniciar Embedded Signup. Resolvé este estado antes
                del deadline o hacé offboarding controlado.
              </small>
            </span>
          </div>
        )}

        {status.tokenExpired && (
          <div class="settings-policy-alert" role="alert">
            <Icon name="alert" size={18} />
            <span>
              <strong>La credencial o el acceso a datos de Meta venció</strong>
              <small>
                Los envíos siguen pausados. Completá el offboarding local
                controlado antes de iniciar un nuevo Embedded Signup.
              </small>
            </span>
          </div>
        )}

        {status.attentionRequired && (
          <div class="settings-policy-alert" role="alert">
            <Icon name="alert" size={18} />
            <span>
              <strong>La conexión de WhatsApp requiere atención</strong>
              <small>
                Los envíos de esta cuenta están pausados y los datos existentes
                se conservaron. Revisá la credencial y completá una reconexión
                controlada antes de volver a habilitarla.
              </small>
              {status.attentionReason && <code>{status.attentionReason}</code>}
            </span>
          </div>
        )}

        {lastError && (
          <div class="whatsapp-signup-last-error" role="alert">
            <span>Último error</span>
            <code>{lastError}</code>
          </div>
        )}

        {status.enabled && !status.connected && !partialAccount && (
          <label class="settings-checkbox whatsapp-signup-history-choice">
            <input
              type="checkbox"
              checked={historyAccepted.value}
              disabled={Boolean(action.value) || blockingAttempt}
              onChange$={(_, element) =>
                (historyAccepted.value = element.checked)
              }
            />
            <span>
              Solicitar también el historial disponible de WhatsApp Business
              <small>
                Si queda desmarcado, se sincronizarán los contactos pero no se
                solicitará history.
              </small>
            </span>
          </label>
        )}

        {!status.enabled && !loadingStatus.value && (
          <div class="settings-policy-alert" role="status">
            <Icon name="info" size={18} />
            <span>
              <strong>Embedded Signup está deshabilitado</strong>
              <small>
                El feature flag backend permanece apagado. No se carga el SDK de
                Meta ni se puede iniciar Facebook Login.
              </small>
            </span>
          </div>
        )}

        {status.enabled && !status.configured && !loadingStatus.value && (
          <div class="settings-policy-alert" role="alert">
            <Icon name="alert" size={18} />
            <span>
              <strong>Embedded Signup todavía no está configurado</strong>
              <small>
                App ID y Configuration ID deben estar disponibles en la
                configuración pública validada por el backend.
              </small>
            </span>
          </div>
        )}

        {blockingAttempt && (
          <div class="settings-policy-alert" role="alert">
            <Icon name="info" size={18} />
            <span>
              <strong>Ya existe un onboarding activo o incompleto</strong>
              <small>
                Cancelalo o resolvelo antes de iniciar otro. Los callbacks
                duplicados se rechazan.
              </small>
            </span>
          </div>
        )}

        {tabAttemptLocked.value && !status.connected && !partialAccount && (
          <div class="settings-policy-alert" role="alert">
            <Icon name="info" size={18} />
            <span>
              <strong>Esta pestaña ya abrió Embedded Signup</strong>
              <small>
                Meta no incluye un identificador de sesión en FINISH. Para
                evitar mezclar un callback tardío con un código nuevo, cerrá
                esta pestaña y cualquier ventana de Meta; luego abrí el panel en
                una pestaña nueva si necesitás reintentar.
              </small>
            </span>
          </div>
        )}

        {partialAccount && !status.connected && (
          <div class="settings-policy-alert" role="alert">
            <Icon name="alert" size={18} />
            <span>
              <strong>La cuenta quedó en un estado parcial</strong>
              <small>
                No se puede iniciar otro onboarding mientras exista la
                credencial. Revisá la sincronización o ejecutá el offboarding
                controlado; los mensajes importados se conservarán.
              </small>
            </span>
          </div>
        )}

        {message.value && (
          <div
            class={{ "google-calendar-feedback": true, error: error.value }}
            role={error.value ? "alert" : "status"}
            aria-live={error.value ? "assertive" : "polite"}
          >
            <Icon name={error.value ? "alert" : "info"} size={18} />
            <span>{message.value}</span>
          </div>
        )}

        <div class="whatsapp-signup-actions">
          {!status.connected && !partialAccount && (
            <button
              class="primary-button"
              type="button"
              disabled={!canStart}
              onClick$={startOnboarding}
            >
              {action.value === "start"
                ? "Preparando conexión…"
                : action.value === "exchange"
                  ? "Validando código…"
                  : action.value === "finish"
                    ? "Guardando activos…"
                    : "Conectar WhatsApp Business con Coexistence"}
            </button>
          )}
          {blockingAttempt && (
            <button
              class="secondary-button danger-button"
              type="button"
              disabled={Boolean(action.value)}
              onClick$={() =>
                cancelAttempt(
                  activeSession.value?.attemptId || status.attemptId,
                )
              }
            >
              {action.value === "cancel"
                ? "Cancelando…"
                : "Cancelar intento incompleto"}
            </button>
          )}
          {(status.connected || partialAccount) && (
            <button
              class="secondary-button danger-button"
              type="button"
              disabled={Boolean(action.value)}
              onClick$={offboard}
            >
              {action.value === "offboard"
                ? "Retirando integración…"
                : "Retirar integración técnica"}
            </button>
          )}
        </div>
      </div>
    );
  },
);
