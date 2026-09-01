import {
  $,
  component$,
  useContext,
  useSignal,
  useStore,
  useVisibleTask$,
} from "@qwik.dev/core";
import { APP_USER_CONTEXT } from "~/components/app/AppUserContext";
import { BOT_AUTOMATION_CONTEXT } from "~/components/app/BotAutomationContext";
import {
  conversationAutomationDisplayState,
  conversationAutomationTestStateFromRpc,
  formatConversationTestOverrideUntil,
  type ConversationAutomationTestState,
} from "~/lib/conversation-automation-test";
import { getSupabaseClient } from "~/lib/supabase/client";
import { Icon } from "../ui/Icon";

interface ConversationBotTestControlProps {
  conversationId: string;
  automationMode: "auto" | "manual";
  needsHuman: boolean;
  conversationStatus: "open" | "closed";
}

interface ControlState {
  value: ConversationAutomationTestState | null;
  loading: boolean;
  saving: boolean;
  error: string;
}

const READ_ERROR =
  "No pudimos consultar el estado de prueba de este chat. Intentá nuevamente.";
const SAVE_ERROR =
  "No pudimos confirmar el cambio. Volvé a consultar el estado antes de continuar.";

async function readState(
  conversationId: string,
): Promise<ConversationAutomationTestState> {
  const { data, error } = await getSupabaseClient().rpc(
    "get_whatsapp_conversation_automation_state",
    { p_conversation_id: conversationId },
  );
  const state = conversationAutomationTestStateFromRpc(data);
  if (error || !state || state.conversationId !== conversationId) {
    throw new Error(error?.message ?? "INVALID_AUTOMATION_STATE");
  }
  return state;
}

export const ConversationBotTestControl =
  component$<ConversationBotTestControlProps>((props) => {
    const appUser = useContext(APP_USER_CONTEXT);
    const globalBot = useContext(BOT_AUTOMATION_CONTEXT);
    const state = useStore<ControlState>({
      value: null,
      loading: true,
      saving: false,
      error: "",
    });
    const currentTime = useSignal(Date.now());
    const selectedConversationId = useSignal(props.conversationId);
    const stateRequestVersion = useSignal(0);

    const reload = $(async (targetConversationId: string) => {
      const requestVersion = ++stateRequestVersion.value;
      state.loading = true;
      state.error = "";
      try {
        const next = await readState(targetConversationId);
        if (
          selectedConversationId.value !== targetConversationId ||
          stateRequestVersion.value !== requestVersion
        ) {
          return;
        }
        state.value = next;
      } catch {
        if (
          selectedConversationId.value !== targetConversationId ||
          stateRequestVersion.value !== requestVersion
        ) {
          return;
        }
        state.value = null;
        state.error = READ_ERROR;
      } finally {
        if (
          selectedConversationId.value === targetConversationId &&
          stateRequestVersion.value === requestVersion
        ) {
          state.loading = false;
        }
      }
    });

    // The selected conversation can change without remounting the chat panel.
    // eslint-disable-next-line qwik/no-use-visible-task
    useVisibleTask$(async ({ track }) => {
      const targetConversationId = track(() => props.conversationId);
      selectedConversationId.value = targetConversationId;
      state.value = null;
      state.error = "";
      state.saving = false;
      await reload(targetConversationId);
    });

    // The global switch can change from the shared sidebar while this chat is
    // open. Re-read the combined SQL state instead of deriving authority only
    // from a stale per-chat response.
    // eslint-disable-next-line qwik/no-use-visible-task
    useVisibleTask$(async ({ track }) => {
      const globalEnabled = track(() => globalBot.enabled);
      if (
        globalEnabled !== null &&
        state.value &&
        state.value.globalAutomationsEnabled !== globalEnabled
      ) {
        await reload(props.conversationId);
      }
    });

    // Expiration is a live boundary: do not leave an expired override looking
    // active merely because the inbox stayed open.
    // eslint-disable-next-line qwik/no-use-visible-task
    useVisibleTask$(({ cleanup }) => {
      const timer = window.setInterval(() => {
        currentTime.value = Date.now();
      }, 30_000);
      cleanup(() => window.clearInterval(timer));
    });

    const mutate = $(async (action: "activate" | "deactivate") => {
      if (!appUser.isAdmin || state.saving) return;
      const targetConversationId = props.conversationId;
      if (
        selectedConversationId.value !== targetConversationId ||
        state.value?.conversationId !== targetConversationId
      ) {
        return;
      }
      const activating = action === "activate";
      const confirmation = activating
        ? "¿Activar el bot sólo para este chat durante 24 horas? Esto no enciende el bot global ni quita pausas de seguridad."
        : "¿Desactivar la prueba solamente para este chat?";
      if (!window.confirm(confirmation)) return;

      const requestVersion = ++stateRequestVersion.value;
      state.saving = true;
      state.error = "";
      try {
        const functionName = activating
          ? "activate_whatsapp_conversation_test_override"
          : "deactivate_whatsapp_conversation_test_override";
        const { data, error } = await getSupabaseClient().rpc(functionName, {
          p_conversation_id: targetConversationId,
        });
        const next = conversationAutomationTestStateFromRpc(data);
        if (error || !next || next.conversationId !== targetConversationId) {
          throw new Error(error?.message ?? "INVALID_AUTOMATION_STATE");
        }
        if (
          selectedConversationId.value !== targetConversationId ||
          stateRequestVersion.value !== requestVersion
        ) {
          return;
        }
        state.value = next;
        currentTime.value = Date.now();
      } catch {
        if (
          selectedConversationId.value === targetConversationId &&
          stateRequestVersion.value === requestVersion
        ) {
          // A transport failure can happen after the transaction committed.
          // Hide actions until a fresh read instead of presenting stale state
          // as authoritative or allowing a blind retry to extend the window.
          state.value = null;
          state.error = SAVE_ERROR;
        }
      } finally {
        if (
          selectedConversationId.value === targetConversationId &&
          stateRequestVersion.value === requestVersion
        ) {
          state.saving = false;
        }
      }
    });

    const currentState =
      state.value?.conversationId === props.conversationId ? state.value : null;
    const controlLoading =
      state.loading || selectedConversationId.value !== props.conversationId;
    const displayError =
      selectedConversationId.value === props.conversationId ? state.error : "";
    const liveConversationState = currentState
      ? {
          ...currentState,
          automationMode: props.automationMode,
          needsHuman: props.needsHuman,
          conversationStatus: props.conversationStatus,
        }
      : null;
    const display = conversationAutomationDisplayState(
      liveConversationState,
      currentState ? null : globalBot.enabled,
      currentTime.value,
    );
    const until =
      display.overrideActive && currentState?.testOverrideUntil
        ? formatConversationTestOverrideUntil(currentState.testOverrideUntil)
        : null;
    const globalEnabled = display.globalLabel === "Activo";
    const canActivate =
      appUser.isAdmin &&
      currentState !== null &&
      !globalEnabled &&
      !display.overrideActive;
    const canExtend =
      appUser.isAdmin &&
      currentState !== null &&
      !globalEnabled &&
      display.overrideActive;
    const canDeactivate =
      appUser.isAdmin && currentState !== null && display.overrideActive;

    return (
      <section
        class={{
          "conversation-bot-card": true,
          active: display.effectiveForChat,
          loading: controlLoading,
          error: Boolean(displayError),
        }}
        aria-labelledby="conversation-bot-title"
        aria-busy={controlLoading || state.saving}
        aria-live="polite"
      >
        <div class="conversation-bot-heading">
          <span class="conversation-bot-icon" aria-hidden="true">
            <Icon name="bot" size={18} />
          </span>
          <div>
            <h2 id="conversation-bot-title">Bot en este chat</h2>
            <p>
              Una prueba individual no enciende el bot para los demás chats.
            </p>
          </div>
        </div>

        <dl class="conversation-bot-statuses">
          <div>
            <dt>Bot global</dt>
            <dd>{controlLoading ? "Consultando…" : display.globalLabel}</dd>
          </div>
          <div>
            <dt>Este chat</dt>
            <dd>{controlLoading ? "Consultando…" : display.chatLabel}</dd>
          </div>
          {until && (
            <div>
              <dt>Activo hasta</dt>
              <dd>{until} hs</dd>
            </div>
          )}
        </dl>

        {!controlLoading && display.overrideActive && globalEnabled && (
          <p class="conversation-bot-note">
            La prueba individual sigue programada, pero no cambia el
            funcionamiento mientras el bot global está activo.
          </p>
        )}
        {!controlLoading &&
          display.overrideActive &&
          !display.effectiveForChat && (
            <p class="conversation-bot-note warning">
              La ventana de prueba está habilitada, pero la pausa o el estado
              seguro de esta conversación sigue bloqueando la automatización.
            </p>
          )}

        {displayError && (
          <p class="conversation-bot-error" role="alert">
            {displayError}
          </p>
        )}

        <div class="conversation-bot-actions">
          {canActivate && (
            <button
              class="primary-button small"
              type="button"
              disabled={controlLoading || state.saving}
              onClick$={() => mutate("activate")}
            >
              Activar bot 24 h para este chat
            </button>
          )}
          {canExtend && (
            <button
              class="secondary-button small"
              type="button"
              disabled={controlLoading || state.saving}
              onClick$={() => mutate("activate")}
            >
              Extender 24 h desde ahora
            </button>
          )}
          {canDeactivate && (
            <button
              class="secondary-button small"
              type="button"
              disabled={controlLoading || state.saving}
              onClick$={() => mutate("deactivate")}
            >
              Desactivar prueba
            </button>
          )}
          {displayError && !state.saving && (
            <button
              class="text-button"
              type="button"
              onClick$={() => reload(props.conversationId)}
            >
              Reintentar
            </button>
          )}
        </div>
      </section>
    );
  });
