import { $, component$, useContext } from "@qwik.dev/core";
import { APP_USER_CONTEXT } from "~/components/app/AppUserContext";
import { BOT_AUTOMATION_CONTEXT } from "~/components/app/BotAutomationContext";
import { Icon } from "~/components/ui/Icon";
import { getSupabaseClient } from "~/lib/supabase/client";

interface BotAutomationControlProps {
  variant: "sidebar" | "home";
}

const READ_ERROR =
  "No pudimos consultar el bot. Revisá la conexión e intentá de nuevo.";
const SAVE_ERROR =
  "No pudimos confirmar el cambio. Tocá Reintentar para consultar el estado actual.";

export const BotAutomationControl = component$<BotAutomationControlProps>(
  ({ variant }) => {
    const appUser = useContext(APP_USER_CONTEXT);
    const bot = useContext(BOT_AUTOMATION_CONTEXT);
    const statusId = `bot-automation-${variant}-status`;

    const reload = $(async () => {
      if (bot.saving) return;
      bot.saving = true;
      bot.error = "";

      try {
        const { data, error } = await getSupabaseClient()
          .from("app_settings")
          .select("automations_enabled")
          .eq("id", true)
          .single();

        if (error || typeof data?.automations_enabled !== "boolean") {
          bot.error = READ_ERROR;
          return;
        }
        bot.enabled = data.automations_enabled;
      } catch {
        bot.error = READ_ERROR;
      } finally {
        bot.saving = false;
      }
    });

    const toggle = $(async (next: boolean) => {
      if (bot.saving || bot.enabled === null || next === bot.enabled) return;

      const previous = bot.enabled;
      bot.enabled = next;
      bot.saving = true;
      bot.error = "";

      try {
        // `select().single()` hace visible un update bloqueado por RLS. Sin
        // esa confirmación, Supabase puede responder sin error aunque no haya
        // actualizado ninguna fila.
        const { data, error } = await getSupabaseClient()
          .from("app_settings")
          .update({ automations_enabled: next })
          .eq("id", true)
          .select("automations_enabled")
          .single();

        if (error || data?.automations_enabled !== next) {
          bot.enabled = previous;
          bot.error = SAVE_ERROR;
        }
      } catch {
        bot.enabled = previous;
        bot.error = SAVE_ERROR;
      } finally {
        bot.saving = false;
      }
    });

    if (!appUser.isAdmin) return null;

    const enabled = bot.enabled === true;
    const title =
      bot.enabled === null
        ? "Estado del bot no disponible"
        : enabled
          ? "Bot encendido"
          : "Bot apagado";
    const description =
      bot.enabled === null
        ? "Volvé a consultar el estado"
        : enabled
          ? "Responde los mensajes nuevos"
          : "No responde automáticamente";

    return (
      <div
        class={{
          "bot-automation-control": true,
          "nav-bot-control": variant === "sidebar",
          "dashboard-bot-control": variant === "home",
          on: enabled,
          error: Boolean(bot.error),
        }}
        aria-busy={bot.saving}
      >
        <label class="bot-toggle-row">
          {variant === "home" && (
            <span class="bot-toggle-icon" aria-hidden="true">
              <Icon name="bot" size={21} />
            </span>
          )}
          <span class="bot-toggle-copy">
            <strong>
              {variant === "sidebar" && <Icon name="bot" size={16} />}
              {bot.saving ? "Guardando…" : title}
            </strong>
            {variant === "home" && <small>{description}</small>}
          </span>
          <input
            class="bot-toggle-input"
            type="checkbox"
            role="switch"
            checked={enabled}
            disabled={bot.enabled === null || bot.saving}
            aria-label={enabled ? "Apagar el bot" : "Encender el bot"}
            aria-describedby={statusId}
            onChange$={(_, element) => toggle(element.checked)}
          />
          <span class="bot-toggle-track" aria-hidden="true" />
        </label>

        <span
          id={statusId}
          class={{
            "bot-toggle-feedback": true,
            "sr-only": !bot.error,
          }}
          role={bot.error ? "alert" : "status"}
          aria-live={bot.error ? "assertive" : "polite"}
        >
          {bot.error || (bot.saving ? "Guardando el estado del bot" : title)}
        </span>

        {bot.error && (
          <button
            class="bot-toggle-retry"
            type="button"
            disabled={bot.saving}
            onClick$={reload}
          >
            Reintentar
          </button>
        )}
      </div>
    );
  },
);
