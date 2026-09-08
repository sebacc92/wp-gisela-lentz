import assert from "node:assert/strict";
import test from "node:test";

import {
  captchaOptions,
  isCaptchaError,
  turnstileSitekey,
  TURNSTILE_SCRIPT_URL,
} from "./turnstile.ts";

const SITEKEY = "0x4AAAAAAEsC2vo0kNxMsJaa";

test("un sitekey ausente o mal formado deja el login como estaba", () => {
  assert.equal(turnstileSitekey(SITEKEY), SITEKEY);
  assert.equal(turnstileSitekey(` ${SITEKEY} `), SITEKEY);
  for (const raw of [
    undefined,
    null,
    "",
    "   ",
    "corto",
    "con espacio",
    "a".repeat(65),
  ]) {
    assert.equal(turnstileSitekey(raw), null, String(raw));
  }
});

test("el token sólo se agrega a la llamada cuando existe de verdad", () => {
  assert.deepEqual(captchaOptions("token-real"), {
    captchaToken: "token-real",
  });
  assert.deepEqual(captchaOptions(" token-real "), {
    captchaToken: "token-real",
  });
  for (const empty of [undefined, null, "", "   "]) {
    assert.deepEqual(captchaOptions(empty), {}, String(empty));
  }
});

test("un rechazo por captcha no se confunde con una contraseña incorrecta", () => {
  assert.equal(
    isCaptchaError(
      "captcha protection: request disallowed (invalid-input-response)",
    ),
    true,
  );
  assert.equal(isCaptchaError("Captcha verification process failed"), true);
  assert.equal(isCaptchaError("Invalid login credentials"), false);
  assert.equal(isCaptchaError(undefined), false);
});

test("el script se pide a Cloudflare con render explícito", () => {
  // El render implícito no devuelve un id de widget y sin id no se puede
  // resetear el token gastado en el intento anterior.
  assert.match(
    TURNSTILE_SCRIPT_URL,
    /^https:\/\/challenges\.cloudflare\.com\//,
  );
  assert.match(TURNSTILE_SCRIPT_URL, /render=explicit/);
});
