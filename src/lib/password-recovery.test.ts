import assert from "node:assert/strict";
import test from "node:test";

import {
  authLinkHasError,
  PASSWORD_MIN_LENGTH,
  PASSWORD_RECOVERY_SENT_MESSAGE,
  PASSWORD_RESET_PATH,
  passwordAuthCallback,
  passwordResetRedirectUrl,
  validateNewPassword,
} from "./password-recovery.ts";

test("el redirect de recuperación usa el origin confiable y la ruta canónica", () => {
  assert.equal(PASSWORD_RESET_PATH, "/login/reset/");
  assert.equal(
    passwordResetRedirectUrl("https://giselalentz.com.ar/app?unsafe=1"),
    "https://giselalentz.com.ar/login/reset/",
  );
  assert.equal(
    passwordResetRedirectUrl("http://localhost:5173/login"),
    "http://localhost:5173/login/reset/",
  );
});

test("la validación exige longitud mínima y coincidencia", () => {
  assert.equal(PASSWORD_MIN_LENGTH, 12);
  assert.equal(
    validateNewPassword("demasiado", "demasiado"),
    "Usá al menos 12 caracteres.",
  );
  assert.equal(
    validateNewPassword("una-clave-segura", "otra-clave-segura"),
    "Las contraseñas no coinciden.",
  );
  assert.equal(validateNewPassword("una-clave-segura", "una-clave-segura"), "");
});

test("detecta errores de enlaces tanto en query como en hash", () => {
  assert.equal(
    authLinkHasError(
      new URL("https://example.test/login/reset/?error_code=otp_expired"),
    ),
    true,
  );
  assert.equal(
    authLinkHasError(
      new URL("https://example.test/login/reset/#error=access_denied"),
    ),
    true,
  );
  assert.equal(
    authLinkHasError(
      new URL(
        "https://example.test/login/reset/#access_token=opaque&type=recovery",
      ),
    ),
    false,
  );
});

test("sólo reconoce callbacks implicit completos de invite o recovery", () => {
  assert.deepEqual(
    passwordAuthCallback(
      new URL(
        "https://example.test/login/reset/#type=recovery&access_token=access-a&refresh_token=refresh-a",
      ),
    ),
    { action: "recovery", accessToken: "access-a" },
  );
  assert.deepEqual(
    passwordAuthCallback(
      new URL(
        "https://example.test/login/reset/#type=invite&access_token=access-b&refresh_token=refresh-b",
      ),
    ),
    { action: "invite", accessToken: "access-b" },
  );
  assert.equal(
    passwordAuthCallback(
      new URL("https://example.test/login/reset/#type=invite&access_token=x"),
    ),
    null,
  );
  assert.equal(
    passwordAuthCallback(
      new URL("https://example.test/login/reset/?type=invite&code=fake"),
    ),
    null,
  );
  assert.equal(
    passwordAuthCallback(new URL("https://example.test/login/reset/")),
    null,
  );
});

test("el mensaje de recuperación no revela si la cuenta existe", () => {
  assert.match(PASSWORD_RECOVERY_SENT_MESSAGE, /Si existe una cuenta/);
  assert.doesNotMatch(PASSWORD_RECOVERY_SENT_MESSAGE, /no existe/i);
});
