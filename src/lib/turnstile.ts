/**
 * Turnstile en el login. El token viaja hasta Supabase Auth, que lo verifica
 * contra Cloudflare con la clave secreta del widget. Esta aplicación sólo lo
 * transporta: no conoce el secreto y no decide si un intento es humano.
 *
 * Supabase valida `success`, pero no expone `action` ni `hostname`, así que
 * esas dos comprobaciones del flujo canónico no existen acá. El `action` queda
 * sólo como etiqueta para las métricas del panel de Turnstile.
 */

/** El sitekey es público, pero un valor cualquiera no debe encender el widget:
 * sin formato válido se trata como no configurado y el login queda como antes.
 * Así el desarrollo sigue andando mientras el CAPTCHA no esté activo. */
const SITEKEY_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export const TURNSTILE_SCRIPT_URL =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

export const TURNSTILE_ACTION = "login";

export const TURNSTILE_PENDING_MESSAGE =
  "Esperá un momento a que termine la verificación de seguridad.";

export const TURNSTILE_FAILED_MESSAGE =
  "La verificación de seguridad no se completó. Probá otra vez.";

export interface TurnstileRenderOptions {
  sitekey: string;
  action?: string;
  callback?: (token: string) => void;
  "expired-callback"?: () => void;
  "error-callback"?: () => void;
}

export interface TurnstileApi {
  render: (
    element: HTMLElement,
    options: TurnstileRenderOptions,
  ) => string | undefined;
  reset: (widgetId?: string) => void;
  remove: (widgetId?: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

export function turnstileSitekey(
  raw: string | null | undefined,
): string | null {
  const value = (raw ?? "").trim();
  return SITEKEY_PATTERN.test(value) ? value : null;
}

/** Supabase recibe el token dentro de las opciones de cada llamada. Sin token
 * devuelve un objeto vacío y la llamada queda idéntica a la de antes. */
export function captchaOptions(token: string | null | undefined): {
  captchaToken?: string;
} {
  const value = (token ?? "").trim();
  return value ? { captchaToken: value } : {};
}

/** Supabase responde con un mensaje de captcha cuando el token venció, ya se
 * usó o nunca llegó. Es un problema de la verificación, no de la contraseña:
 * decirle a alguien que su contraseña está mal cuando no lo está manda a
 * cambiarla al pedo. */
export function isCaptchaError(message: string | null | undefined): boolean {
  return /captcha/i.test(message ?? "");
}

let scriptPromise: Promise<void> | null = null;

/** Una sola carga por documento: dos renders no pueden pedir el script dos
 * veces. Un fallo se olvida para que el próximo intento vuelva a probar. */
export function loadTurnstile(): Promise<void> {
  if (typeof document === "undefined" || window.turnstile) {
    return Promise.resolve();
  }
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = TURNSTILE_SCRIPT_URL;
    script.async = true;
    script.defer = true;
    script.addEventListener("load", () => resolve());
    script.addEventListener("error", () => {
      scriptPromise = null;
      reject(new Error("TURNSTILE_SCRIPT_UNAVAILABLE"));
    });
    document.head.appendChild(script);
  });
  return scriptPromise;
}
