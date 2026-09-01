import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

test("login solicita un enlace con respuesta no enumerable", () => {
  const login = source("src/routes/login/index.tsx");

  assert.match(login, /resetPasswordForEmail\(/);
  assert.match(
    login,
    /redirectTo:\s*passwordResetRedirectUrl\(location\.url\.origin\)/,
  );
  assert.match(login, /PASSWORD_RECOVERY_SENT_MESSAGE/);
  assert.match(login, /¿Olvidaste tu contraseña\?/);
  assert.doesNotMatch(login, /auth\.admin/);
  assert.doesNotMatch(login, /service[_-]?role/i);
});

test("la pantalla de invitación o recovery exige un enlace válido y sesión", () => {
  const reset = source("src/routes/login/reset/index.tsx");

  assert.match(reset, /new URL\(window\.location\.href\)/);
  assert.match(reset, /authLinkHasError\(callbackUrl\)/);
  assert.match(reset, /passwordAuthCallback\(callbackUrl\)/);
  assert.match(reset, /client\.auth\.onAuthStateChange/);
  assert.match(reset, /client\.auth\.getSession\(\)/);
  assert.match(reset, /authCallback\.action === "recovery"/);
  assert.match(reset, /event === "PASSWORD_RECOVERY"/);
  assert.match(reset, /authCallback\.action === "invite"/);
  assert.match(reset, /event === "SIGNED_IN"/);
  assert.match(reset, /accessToken !== authCallback\.accessToken/);
  assert.match(reset, /state\.value !== "checking"/);
  assert.match(reset, /acceptCallbackSession\(session\.access_token\)/);
  assert.match(reset, /if \(!acceptedAuthCallback\) state\.value = "invalid"/);
  assert.doesNotMatch(reset, /session \? "ready" : "invalid"/);
  assert.match(reset, /El enlace no es válido o ya venció/);
});

test("una contraseña válida se guarda mediante la sesión del usuario", () => {
  const reset = source("src/routes/login/reset/index.tsx");

  assert.match(reset, /validateNewPassword\(/);
  assert.match(reset, /autocomplete="new-password"/);
  assert.match(
    reset,
    /auth\.updateUser\(\{[\s\S]*?password:\s*password\.value/,
  );
  assert.match(reset, /await navigate\("\/app"\)/);
  assert.doesNotMatch(reset, /auth\.admin/);
  assert.doesNotMatch(reset, /service[_-]?role/i);
  assert.doesNotMatch(reset, /console\.(?:log|info|debug)\([^)]*password/i);
});

test("las pantallas de credenciales permanecen fuera de índices", () => {
  const login = source("src/routes/login/index.tsx");
  const reset = source("src/routes/login/reset/index.tsx");

  assert.match(login, /noindex, nofollow, noarchive/);
  assert.match(reset, /noindex, nofollow, noarchive/);
});
