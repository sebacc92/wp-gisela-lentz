import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  PASSWORD_RECOVERY_SENT_MESSAGE,
  passwordResetRedirectUrl,
  validateNewPassword,
} from "./password-recovery.ts";
import {
  captchaOptions,
  isCaptchaError,
  TURNSTILE_FAILED_MESSAGE,
  TURNSTILE_PENDING_MESSAGE,
} from "./turnstile.ts";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

test("las dos llamadas de auth del login viajan con el token de Turnstile", () => {
  const login = source("src/routes/login/index.tsx");

  // Supabase exige el token en todo endpoint de auth cuando el CAPTCHA está
  // activo. Una llamada sin token deja esa puerta rota en producción.
  assert.match(
    login,
    /signInWithPassword\(\{[\s\S]*?options: captchaOptions\(captchaToken\.value\),[\s\S]*?\}\)/,
  );
  assert.match(
    login,
    /resetPasswordForEmail\([\s\S]*?\.\.\.captchaOptions\(captchaToken\.value\),[\s\S]*?\)/,
  );

  // updateUser de /login/reset usa la sesión de recuperación: pedirle captcha
  // rompería el cambio de contraseña sin agregar protección.
  assert.doesNotMatch(source("src/routes/login/reset/index.tsx"), /captcha/i);
});

test("un intento gastado no reusa el token ni bloquea el formulario", () => {
  const login = source("src/routes/login/index.tsx");

  // El token es de un solo uso: sin reset tras un intento fallido, el segundo
  // envío llega con uno ya redimido y Supabase lo rechaza como bot.
  const signIn = login.indexOf("signInWithPassword");
  const recovery = login.indexOf("resetPasswordForEmail");
  assert.ok(signIn >= 0 && recovery > signIn);
  assert.match(login.slice(signIn, recovery), /await resetCaptcha\(\)/);
  assert.match(login.slice(recovery), /await resetCaptcha\(\)/);
  assert.match(login, /window\.turnstile\?\.reset\(captchaWidget\.value\)/);
});

test("sin sitekey configurado el login queda exactamente como antes", () => {
  const login = source("src/routes/login/index.tsx");

  // El widget y el bloqueo previo al envío cuelgan del mismo interruptor, así
  // que un entorno sin sitekey no puede quedar trabado sin poder entrar.
  assert.match(login, /const CAPTCHA_SITEKEY = turnstileSitekey\(/);
  assert.match(login, /\{CAPTCHA_SITEKEY && \(\s*<div\s+class="login-captcha"/);
  assert.match(
    login,
    /if \(CAPTCHA_SITEKEY && !captchaToken\.value\) \{\s*error\.value = TURNSTILE_PENDING_MESSAGE;/,
  );
});

const LOGIN_ROUTE = "src/routes/login/index.tsx";
const RESET_ROUTE = "src/routes/login/reset/index.tsx";
const CONFIGURATION_ERROR_MESSAGE = "Configuración no disponible";
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
  ...args: string[]
) => (...args: unknown[]) => Promise<void>;

// Ejecuta el cuerpo real del handler, con dependencias aisladas: ninguna prueba
// inicia sesión, envía emails ni modifica contraseñas de usuarios reales.
function handler(route: string, event: "submit" | "recovery" | "session") {
  const pattern =
    event === "session"
      ? /useVisibleTask\$\(async \(\) => \{([\s\S]*?)\n  \}\);/
      : event === "recovery"
        ? /onClick\$=\{async \(\) => \{([\s\S]*?)\n\s+\}\}/
        : /onSubmit\$=\{async \(\) => \{([\s\S]*?)\n\s+\}\}/;
  const body = source(route).match(pattern)?.[1];
  assert.ok(body, `No se encontró ${event} en ${route}`);
  return (bindings: Record<string, unknown>) =>
    new AsyncFunction(...Object.keys(bindings), body)(
      ...Object.values(bindings),
    );
}

function authFixture() {
  const navigations: string[] = [];
  let clientCalls = 0;
  let resets = 0;
  const auth = {
    getSession: async () => ({ data: { session: null }, error: null }),
    signInWithPassword: async () => ({ error: null }),
    resetPasswordForEmail: async () => ({ error: null }),
    updateUser: async () => ({ error: null }),
  };
  const context = {
    configured: true,
    CONFIGURATION_ERROR_MESSAGE,
    CAPTCHA_SITEKEY: "sitekey-present",
    captchaToken: { value: "fresh-token" },
    error: { value: "" },
    email: { value: "test@example.test" },
    password: { value: "una-clave-segura" },
    confirmation: { value: "una-clave-segura" },
    loading: { value: false },
    recoveryLoading: { value: false },
    recoveryMessage: { value: "" },
    state: { value: "ready" },
    location: { url: new URL("https://example.test/login") },
    destination: "/app",
    captchaOptions,
    isCaptchaError,
    TURNSTILE_FAILED_MESSAGE,
    TURNSTILE_PENDING_MESSAGE,
    PASSWORD_RECOVERY_SENT_MESSAGE,
    passwordResetRedirectUrl,
    validateNewPassword,
    resetCaptcha: async () => {
      resets += 1;
      context.captchaToken.value = "";
    },
    getSupabaseClient: () => {
      clientCalls += 1;
      return { auth };
    },
    navigate: async (path: string) => {
      navigations.push(path);
    },
  };
  return {
    context,
    auth,
    navigations,
    clientCalls: () => clientCalls,
    resets: () => resets,
  };
}

test("sin configuración, sesión, login y recuperación no llaman a Supabase", async () => {
  for (const event of ["session", "submit", "recovery"] as const) {
    const fixture = authFixture();
    fixture.context.configured = false;
    await handler(LOGIN_ROUTE, event)(fixture.context);
    assert.equal(fixture.clientCalls(), 0, event);
    assert.equal(fixture.context.error.value, CONFIGURATION_ERROR_MESSAGE);
    assert.equal(fixture.context.loading.value, false);
    assert.equal(fixture.context.recoveryLoading.value, false);
  }
  assert.equal(
    source(LOGIN_ROUTE).match(
      /disabled=\{!configured \|\| loading\.value \|\| recoveryLoading\.value\}/g,
    )?.length,
    2,
  );
});

test("una excepción al validar sesión se muestra sin rechazar la tarea", async () => {
  const fixture = authFixture();
  fixture.auth.getSession = async () => {
    throw new Error("offline");
  };
  await handler(LOGIN_ROUTE, "session")(fixture.context);
  assert.match(fixture.context.error.value, /validar tu sesión/);
  assert.deepEqual(fixture.navigations, []);
});

test("login fallido por excepción libera el botón y renueva la verificación", async () => {
  const fixture = authFixture();
  fixture.auth.signInWithPassword = async () => {
    throw new Error("offline");
  };
  await handler(LOGIN_ROUTE, "submit")(fixture.context);
  assert.equal(fixture.context.loading.value, false);
  assert.equal(fixture.resets(), 1);
  assert.match(fixture.context.error.value, /Revisá la conexión/);
  assert.deepEqual(fixture.navigations, []);

  fixture.auth.signInWithPassword = async () => ({ error: null });
  fixture.context.captchaToken.value = "another-fresh-token";
  await handler(LOGIN_ROUTE, "submit")(fixture.context);
  assert.deepEqual(fixture.navigations, ["/app"]);
  assert.equal(fixture.context.loading.value, false);
});

test("recuperación fallida por excepción libera el botón y permite reintentar", async () => {
  const fixture = authFixture();
  fixture.auth.resetPasswordForEmail = async () => {
    throw new Error("offline");
  };
  await handler(LOGIN_ROUTE, "recovery")(fixture.context);
  assert.equal(fixture.context.recoveryLoading.value, false);
  assert.equal(fixture.resets(), 1);
  assert.equal(fixture.context.recoveryMessage.value, "");
  assert.match(fixture.context.error.value, /Revisá la conexión/);

  fixture.auth.resetPasswordForEmail = async () => ({ error: null });
  fixture.context.captchaToken.value = "another-fresh-token";
  await handler(LOGIN_ROUTE, "recovery")(fixture.context);
  assert.equal(
    fixture.context.recoveryMessage.value,
    PASSWORD_RECOVERY_SENT_MESSAGE,
  );
  assert.equal(fixture.context.recoveryLoading.value, false);
});

test("guardar contraseña sin configuración no llama a Supabase ni queda cargando", async () => {
  const fixture = authFixture();
  fixture.context.configured = false;
  await handler(RESET_ROUTE, "submit")(fixture.context);
  assert.equal(fixture.clientCalls(), 0);
  assert.equal(fixture.context.state.value, "unavailable");
  assert.equal(fixture.context.error.value, CONFIGURATION_ERROR_MESSAGE);
  assert.match(source(RESET_ROUTE), /configured \? "checking" : "unavailable"/);
});

test("guardar contraseña con excepción permite reintentar sin perder lo escrito", async () => {
  const fixture = authFixture();
  fixture.auth.updateUser = async () => {
    throw new Error("offline");
  };
  await handler(RESET_ROUTE, "submit")(fixture.context);
  assert.equal(fixture.context.state.value, "ready");
  assert.equal(fixture.context.password.value, "una-clave-segura");
  assert.match(fixture.context.error.value, /Revisá la conexión/);
  assert.deepEqual(fixture.navigations, []);

  fixture.auth.updateUser = async () => ({ error: null });
  await handler(RESET_ROUTE, "submit")(fixture.context);
  assert.deepEqual(fixture.navigations, ["/app"]);
  assert.equal(fixture.context.password.value, "");
  assert.equal(fixture.context.confirmation.value, "");
});
