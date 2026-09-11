import { createContextId, type QRL, type Signal } from "@qwik.dev/core";
import type { SettingsState } from "./settings-types";

/**
 * Contexto de Configuración.
 *
 * Cada pestaña es un componente que lee este contexto en lugar de recibir
 * veinte props. Guarda el estado compartido y las dos acciones que casi todas
 * las secciones necesitan: recargar y guardar en `app_settings`.
 *
 * Las acciones son QRL porque cruzan el límite de un componente Qwik: así se
 * serializan y la pestaña puede ejecutarlas sin arrastrar el closure entero de
 * la pantalla.
 */
export interface SettingsContextValue {
  state: SettingsState;
  notice: Signal<string>;
  /** Vuelve a leer toda la configuración desde Supabase. */
  reload$: QRL<() => Promise<void>>;
  /** Guarda campos de `app_settings` y deja el aviso correspondiente. */
  saveAppSettings$: QRL<
    (values: Record<string, unknown>, success: string) => Promise<void>
  >;
}

export const SETTINGS_CONTEXT =
  createContextId<SettingsContextValue>("gl.settings");
