import { SITE_ORIGIN } from "../config/site.ts";

export const PASSWORD_RESET_PATH = "/login/reset/";
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_RECOVERY_SENT_MESSAGE =
  "Si existe una cuenta para ese email, vas a recibir un enlace para elegir una contraseña nueva.";

export function passwordResetRedirectUrl(origin: string = SITE_ORIGIN): string {
  const normalizedOrigin = new URL(origin).origin;
  return new URL(PASSWORD_RESET_PATH, normalizedOrigin).href;
}

export function validateNewPassword(
  password: string,
  confirmation: string,
): string {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Usá al menos ${PASSWORD_MIN_LENGTH} caracteres.`;
  }
  if (password !== confirmation) {
    return "Las contraseñas no coinciden.";
  }
  return "";
}

export function authLinkHasError(url: URL): boolean {
  const hash = new URLSearchParams(url.hash.replace(/^#/, ""));
  return Boolean(
    url.searchParams.get("error") ||
    url.searchParams.get("error_code") ||
    hash.get("error") ||
    hash.get("error_code"),
  );
}

export type PasswordAuthAction = "invite" | "recovery";

export interface PasswordAuthCallback {
  action: PasswordAuthAction;
  accessToken: string;
}

export function passwordAuthCallback(url: URL): PasswordAuthCallback | null {
  const hash = new URLSearchParams(url.hash.replace(/^#/, ""));
  const type = hash.get("type");
  const accessToken = hash.get("access_token") ?? "";
  const refreshToken = hash.get("refresh_token") ?? "";
  if (
    (type !== "invite" && type !== "recovery") ||
    !accessToken ||
    !refreshToken
  ) {
    return null;
  }
  return { action: type, accessToken };
}
