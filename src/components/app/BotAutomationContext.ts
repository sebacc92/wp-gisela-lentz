import { createContextId } from "@qwik.dev/core";

export interface BotAutomationContextValue {
  enabled: boolean | null;
  saving: boolean;
  error: string;
}

export const BOT_AUTOMATION_CONTEXT =
  createContextId<BotAutomationContextValue>("gisela-lentz.bot-automation");
