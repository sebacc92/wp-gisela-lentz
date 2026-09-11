import {
  component$,
  useSignal,
  useStore,
  useVisibleTask$,
} from "@qwik.dev/core";
import { Link } from "@qwik.dev/router";
import { Icon } from "~/components/ui/Icon";
import {
  detectInboxNotifications,
  type InboxNotification,
  type InboxSnapshot,
} from "~/lib/inbox-notifications";
import { getSupabaseClient } from "~/lib/supabase/client";
import { watchRealtimeTables } from "~/lib/supabase/realtime";
import "./inbox-notifications.css";

const SOUND_PREFERENCE_KEY = "gl.notification-sound";
const DISMISS_AFTER_MS = 8_000;

/**
 * Avisos de mensajes nuevos y señas confirmadas.
 *
 * Escucha los mismos cambios de Realtime que ya usa el resto del panel y
 * compara contra la lectura anterior, así abrir la aplicación con mensajes
 * viejos sin leer no dispara nada.
 *
 * El sonido queda apagado salvo que se active a mano, y la preferencia se
 * guarda en el navegador: un consultorio con pacientes en la sala no quiere
 * que la computadora suene sola. Además los navegadores no dejan reproducir
 * audio hasta que hubo una interacción, así que un sonido automático sería
 * poco confiable de todos modos.
 */
export const InboxNotifications = component$(() => {
  const soundEnabled = useSignal(false);
  const state = useStore<{ items: InboxNotification[] }>({ items: [] });

  // eslint-disable-next-line qwik/no-use-visible-task
  useVisibleTask$(({ cleanup }) => {
    try {
      soundEnabled.value =
        window.localStorage.getItem(SOUND_PREFERENCE_KEY) === "on";
    } catch {
      // Un navegador con el almacenamiento bloqueado simplemente no suena.
    }

    let previous: InboxSnapshot | null = null;
    let timers: number[] = [];
    let disposed = false;

    const playChime = () => {
      if (!soundEnabled.value) return;
      try {
        // Un tono corto generado al momento evita sumar un archivo de audio
        // al bundle por algo que suena dos segundos.
        const AudioCtor =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext })
            .webkitAudioContext;
        if (!AudioCtor) return;
        const context = new AudioCtor();
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = "sine";
        oscillator.frequency.setValueAtTime(880, context.currentTime);
        gain.gain.setValueAtTime(0.0001, context.currentTime);
        gain.gain.exponentialRampToValueAtTime(
          0.12,
          context.currentTime + 0.02,
        );
        gain.gain.exponentialRampToValueAtTime(
          0.0001,
          context.currentTime + 0.35,
        );
        oscillator.connect(gain).connect(context.destination);
        oscillator.start();
        oscillator.stop(context.currentTime + 0.36);
        oscillator.onended = () => void context.close();
      } catch {
        // Si el navegador bloquea el audio, el aviso visual alcanza.
      }
    };

    const read = async () => {
      if (disposed) return;
      try {
        const client = getSupabaseClient();
        const [conversations, deposits] = await Promise.all([
          client
            .from("conversations")
            .select("unread_count")
            .eq("status", "open"),
          client
            .from("appointments")
            .select("id", { count: "exact", head: true })
            .eq("deposit_status", "confirmed"),
        ]);
        if (conversations.error || deposits.error || disposed) return;

        const next: InboxSnapshot = {
          unreadCount: (conversations.data ?? []).reduce(
            (total, row) => total + Number(row.unread_count ?? 0),
            0,
          ),
          confirmedDeposits: deposits.count ?? 0,
        };

        const found = detectInboxNotifications(previous, next);
        previous = next;
        if (found.length === 0) return;

        state.items = [...state.items, ...found].slice(-3);
        playChime();
        const timer = window.setTimeout(() => {
          state.items = state.items.filter((item) => !found.includes(item));
        }, DISMISS_AFTER_MS);
        timers.push(timer);
      } catch {
        // Un aviso perdido no puede romper la pantalla que se está usando.
      }
    };

    void read();

    let watch: { unsubscribe: () => void } | null = null;
    try {
      watch = watchRealtimeTables({
        client: getSupabaseClient(),
        channelName: "inbox-notifications",
        tables: ["conversations", "appointments"],
        onChange: () => void read(),
      });
    } catch {
      // Sin Realtime no hay avisos en vivo; el resto del panel sigue igual.
    }

    cleanup(() => {
      disposed = true;
      watch?.unsubscribe();
      timers.forEach((timer) => window.clearTimeout(timer));
      timers = [];
    });
  });

  return (
    <div class="inbox-notifications" aria-live="polite">
      {state.items.map((item, index) => (
        <article key={`${item.kind}-${index}`} class="inbox-notification">
          <span class="inbox-notification-icon" aria-hidden="true">
            <Icon
              name={item.kind === "message" ? "message" : "check-circle"}
              size={18}
            />
          </span>
          <Link href={item.href} onClick$={() => (state.items = [])}>
            {item.title}
          </Link>
          <button
            type="button"
            aria-label="Ocultar el aviso"
            onClick$={() => {
              state.items = state.items.filter((entry) => entry !== item);
            }}
          >
            <Icon name="x" size={15} />
          </button>
        </article>
      ))}

      {state.items.length > 0 && (
        <button
          class="inbox-notification-sound"
          type="button"
          aria-pressed={soundEnabled.value}
          title={
            soundEnabled.value
              ? "Silenciar los avisos"
              : "Avisar con un sonido cuando llega algo"
          }
          onClick$={() => {
            soundEnabled.value = !soundEnabled.value;
            try {
              window.localStorage.setItem(
                SOUND_PREFERENCE_KEY,
                soundEnabled.value ? "on" : "off",
              );
            } catch {
              // La preferencia se pierde al recargar, nada más.
            }
          }}
        >
          <Icon name={soundEnabled.value ? "bot" : "info"} size={15} />
          <span>
            {soundEnabled.value ? "Sonido activado" : "Sonido apagado"}
          </span>
        </button>
      )}
    </div>
  );
});
