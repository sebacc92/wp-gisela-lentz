import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { resolveConfig } from "vite";
import {
  assertPublicBuildEnv,
  publicBuildEnvGuard,
} from "./check-public-build-env.mjs";

const validEnv = {
  PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_browser_fixture",
};

async function withCleanBuildEnvironment(run) {
  const names = [
    ...Object.keys(validEnv),
    "PUBLIC_TURNSTILE_SITEKEY",
    "TURNSTILE_SECRET",
    "SUPABASE_SERVICE_ROLE_KEY",
  ];
  const previousEnvironment = names.map((name) => [name, process.env[name]]);
  try {
    for (const name of names) delete process.env[name];
    await run();
  } finally {
    for (const [name, value] of previousEnvironment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function jwt(payload) {
  return [
    Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString(
      "base64url",
    ),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "test-signature",
  ].join(".");
}

test("production requires both public Supabase values at build time", () => {
  for (const environment of [
    {},
    { PUBLIC_SUPABASE_URL: validEnv.PUBLIC_SUPABASE_URL },
    {
      PUBLIC_SUPABASE_PUBLISHABLE_KEY: validEnv.PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    },
    { ...validEnv, PUBLIC_SUPABASE_URL: " " },
    { ...validEnv, PUBLIC_SUPABASE_PUBLISHABLE_KEY: undefined },
  ]) {
    assert.throws(() => assertPublicBuildEnv(environment), /Falta configurar/);
  }
});

test("accepts browser-safe publishable and legacy anon keys; CAPTCHA is optional", () => {
  assert.doesNotThrow(() => assertPublicBuildEnv(validEnv));
  assert.doesNotThrow(() =>
    assertPublicBuildEnv({
      ...validEnv,
      PUBLIC_SUPABASE_URL: "https://auth.example.com/",
      PUBLIC_SUPABASE_PUBLISHABLE_KEY: jwt({ role: "anon" }),
      PUBLIC_TURNSTILE_SITEKEY: "public-widget-id",
    }),
  );
});

test("rejects malformed and privileged keys without revealing their values", () => {
  for (const key of [
    "sb_secret_sensitive-fixture",
    jwt({ role: "service_role", marker: "sensitive-fixture" }),
    jwt({ role: "authenticated" }),
    "bad-key-sensitive-fixture",
    "abc.invalid-json.xyz",
    "sb_publishable_",
    `${validEnv.PUBLIC_SUPABASE_PUBLISHABLE_KEY} `,
  ]) {
    assert.throws(
      () =>
        assertPublicBuildEnv({
          ...validEnv,
          PUBLIC_SUPABASE_PUBLISHABLE_KEY: key,
        }),
      (error) => {
        assert.match(error.message, /clave pública publishable o anon/);
        assert.equal(error.message.includes(key), false);
        assert.equal(error.message.includes("sensitive-fixture"), false);
        return true;
      },
    );
  }
});

test("rejects invalid, insecure or non-base URLs without revealing credentials", () => {
  for (const url of [
    "not-a-url",
    "http://example.supabase.co",
    "https://example.supabase.co/auth/v1",
    "https://example.supabase.co?key=sensitive-fixture",
    "https://example.supabase.co#token",
    "https://user:sensitive-fixture@example.supabase.co",
    " https://example.supabase.co",
  ]) {
    assert.throws(
      () => assertPublicBuildEnv({ ...validEnv, PUBLIC_SUPABASE_URL: url }),
      (error) => {
        assert.match(error.message, /URL HTTPS base/);
        assert.equal(error.message.includes(url), false);
        assert.equal(error.message.includes("sensitive-fixture"), false);
        return true;
      },
    );
  }
});

test("Vite guard fails during production configuration, before compilation", () =>
  withCleanBuildEnvironment(async () => {
    await assert.rejects(
      resolveConfig(
        {
          configFile: false,
          envFile: false,
          envPrefix: ["VITE_", "PUBLIC_"],
          plugins: [publicBuildEnvGuard()],
          mode: "production",
        },
        "build",
      ),
      /Falta configurar PUBLIC_SUPABASE_URL y PUBLIC_SUPABASE_PUBLISHABLE_KEY/,
    );
  }));

test("Vite validates its resolved public environment and keeps secrets out", () =>
  withCleanBuildEnvironment(async () => {
    const directory = await mkdtemp(
      resolve(tmpdir(), "gisela-public-build-env-"),
    );
    try {
      await writeFile(
        resolve(directory, ".env.production"),
        Object.entries({
          ...validEnv,
          PUBLIC_TURNSTILE_SITEKEY: "public-widget-id",
          TURNSTILE_SECRET: "sensitive-fixture",
          SUPABASE_SERVICE_ROLE_KEY: "sensitive-service-fixture",
        })
          .map(([name, value]) => `${name}=${value}`)
          .join("\n"),
      );
      const config = await resolveConfig(
        {
          configFile: false,
          envDir: directory,
          envPrefix: ["VITE_", "PUBLIC_"],
          plugins: [publicBuildEnvGuard()],
          mode: "production",
        },
        "build",
      );
      assert.equal(
        config.env.PUBLIC_SUPABASE_URL,
        validEnv.PUBLIC_SUPABASE_URL,
      );
      assert.equal(
        config.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY,
        validEnv.PUBLIC_SUPABASE_PUBLISHABLE_KEY,
      );
      assert.equal(config.env.PUBLIC_TURNSTILE_SITEKEY, "public-widget-id");
      assert.equal("TURNSTILE_SECRET" in config.env, false);
      assert.equal("SUPABASE_SERVICE_ROLE_KEY" in config.env, false);

      // Pipeline values take precedence over files, including mistaken secrets.
      process.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY =
        "sb_secret_pipeline-fixture";
      await assert.rejects(
        resolveConfig(
          {
            configFile: false,
            envDir: directory,
            envPrefix: ["VITE_", "PUBLIC_"],
            plugins: [publicBuildEnvGuard()],
            mode: "production",
          },
          "build",
        ),
        /clave pública publishable o anon/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }));

test("development can start without configuring Supabase", () =>
  withCleanBuildEnvironment(async () => {
    await assert.doesNotReject(
      resolveConfig(
        {
          configFile: false,
          envFile: false,
          plugins: [publicBuildEnvGuard()],
          mode: "ssr",
        },
        "serve",
      ),
    );
  }));
