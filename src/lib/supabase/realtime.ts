import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";

/**
 * Suscripción Realtime con vuelta atrás explícita.
 *
 * Realtime acelera la pantalla, pero no puede ser la única fuente de
 * actualización: un socket caído es silencioso y dejaría la agenda mostrando
 * datos viejos sin avisar. Por eso `onConnectionChange` informa si el canal
 * está vivo y quien llama mantiene su refresco periódico como respaldo.
 *
 * La publicación `supabase_realtime` sólo incluye `messages`, `conversations`
 * y `appointments`; RLS sigue aplicando sobre cada fila que llega.
 */

export type RealtimeWatchTable = "messages" | "conversations" | "appointments";

export interface RealtimeWatchOptions {
  client: SupabaseClient;
  /** Debe ser único por pantalla para no reutilizar un canal ajeno. */
  channelName: string;
  tables: readonly RealtimeWatchTable[];
  onChange: (table: RealtimeWatchTable) => void;
  onConnectionChange?: (connected: boolean) => void;
  /** Agrupa ráfagas de cambios en un solo refresco. */
  debounceMs?: number;
}

export interface RealtimeWatchHandle {
  unsubscribe: () => void;
}

const DEFAULT_DEBOUNCE_MS = 400;

export function watchRealtimeTables(
  options: RealtimeWatchOptions,
): RealtimeWatchHandle {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: RealtimeWatchTable | null = null;
  let active = true;

  const flush = () => {
    timer = undefined;
    const table = pending;
    pending = null;
    if (active && table) options.onChange(table);
  };

  const schedule = (table: RealtimeWatchTable) => {
    if (!active) return;
    pending = table;
    if (timer !== undefined) return;
    timer = setTimeout(flush, debounceMs);
  };

  let channel: RealtimeChannel = options.client.channel(options.channelName);
  for (const table of options.tables) {
    channel = channel.on(
      "postgres_changes",
      { event: "*", schema: "public", table },
      () => schedule(table),
    );
  }

  channel.subscribe((status) => {
    if (!active) return;
    options.onConnectionChange?.(status === "SUBSCRIBED");
  });

  return {
    unsubscribe: () => {
      active = false;
      if (timer !== undefined) clearTimeout(timer);
      void options.client.removeChannel(channel);
    },
  };
}
