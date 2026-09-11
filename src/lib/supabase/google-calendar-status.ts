import {
  parseGoogleCalendarOperationalStatus,
  type GoogleCalendarOperationalStatus,
} from "~/lib/google-calendar-operational-status";
import { getSupabaseClient } from "./client";

/**
 * Lectura compartida del estado operativo de Google Calendar.
 *
 * El inicio muestra dos cosas que dependen del mismo estado: el aviso de
 * integraciones y el bloque de sincronización. Sin este intermediario cada uno
 * llamaría a la edge function por separado en el mismo render.
 *
 * La caché es deliberadamente corta y se puede saltear con `force`. Después de
 * sincronizar, el estado viejo es incorrecto, no sólo viejo: quien sincroniza
 * pide `force` para no leerse a sí mismo desactualizado.
 */

const CACHE_TTL_MS = 15_000;

interface CachedStatus {
  status: GoogleCalendarOperationalStatus | null;
  loadedAt: number;
}

let cached: CachedStatus | null = null;
let inFlight: Promise<GoogleCalendarOperationalStatus | null> | null = null;

async function fetchStatus(): Promise<GoogleCalendarOperationalStatus | null> {
  try {
    const { data, error } = await getSupabaseClient().functions.invoke(
      "google-calendar-status",
      { method: "GET" },
    );
    return error ? null : parseGoogleCalendarOperationalStatus(data);
  } catch {
    return null;
  }
}

export async function loadGoogleCalendarOperationalStatus(options?: {
  force?: boolean;
  now?: number;
}): Promise<GoogleCalendarOperationalStatus | null> {
  const now = options?.now ?? Date.now();

  if (!options?.force && cached && now - cached.loadedAt < CACHE_TTL_MS) {
    return cached.status;
  }

  // Una segunda pantalla que monta en el mismo tick espera la misma consulta
  // en lugar de abrir otra.
  if (!options?.force && inFlight) return inFlight;

  const request = fetchStatus()
    .then((status) => {
      cached = { status, loadedAt: Date.now() };
      return status;
    })
    .finally(() => {
      if (inFlight === request) inFlight = null;
    });

  inFlight = request;
  return request;
}

/** Descarta la caché: la usa quien acaba de cambiar el estado remoto. */
export function invalidateGoogleCalendarOperationalStatus(): void {
  cached = null;
}
