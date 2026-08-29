import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

function componentSource(): string {
  return readFileSync(
    resolve(
      process.cwd(),
      "src/components/settings/WhatsAppEmbeddedSignup.tsx",
    ),
    "utf8",
  );
}

function startOnboardingSource(): string {
  const source = componentSource();
  const start = source.indexOf("const startOnboarding");
  const end = source.indexOf("const offboard", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  return source.slice(start, end);
}

test("un START rechazado no consume el tombstone antes de abrir Meta", () => {
  const source = startOnboardingSource();
  const invokeStart = source.indexOf('invokeEmbeddedSignup("start"');
  const parseConfiguration = source.indexOf(
    "parseEmbeddedSignupStartConfiguration(response)",
  );
  const reserveTab = source.indexOf(
    "reserveEmbeddedSignupTabAttempt(window.sessionStorage)",
  );
  const loadSdk = source.indexOf("loadFacebookSdk()");

  assert.ok(invokeStart >= 0);
  assert.ok(invokeStart < parseConfiguration);
  assert.ok(parseConfiguration < reserveTab);
  assert.ok(reserveTab < loadSdk);
});

test("todo fallo de START reconcilia el estado aunque no haya configuración", () => {
  const source = startOnboardingSource();
  const catchBlock = source.slice(source.indexOf("} catch (cause)"));

  assert.match(catchBlock, /message\.value = configuration/);
  assert.match(catchBlock, /: startFailureMessage\(cause\)/);
  assert.match(catchBlock, /await refreshStatus\(\)/);
  assert.doesNotMatch(
    catchBlock,
    /if \(configuration\?\.attemptId\) await refreshStatus\(\)/,
  );
});

test("el frontend extrae sólo códigos sanitizados del error HTTP", () => {
  const source = componentSource();

  assert.match(source, /record\(await response\.clone\(\)\.json\(\)\)/);
  assert.match(source, /code = safeErrorCode\(body\?\.error\)/);
  assert.match(source, /WHATSAPP_EMBEDDED_SIGNUP_RATE_LIMITED/);
  assert.doesNotMatch(source, /message\.value\s*=\s*.*response\.clone/);
});
