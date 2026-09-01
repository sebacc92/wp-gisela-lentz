import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  parseJsonc,
  PRODUCTION_CONFIG_PATH,
  STAGING_CONFIG_PATH,
  validateDeploymentScripts,
  validateProductionConfig,
  validateStagingConfig,
} from "./check-cloudflare-config.mjs";
import {
  createWranglerArguments,
  resolveCloudflareCommandMode,
} from "./run-cloudflare-command.mjs";
import { createStagingWranglerDeployArguments } from "./deploy-cloudflare-staging.mjs";

const production = parseJsonc(PRODUCTION_CONFIG_PATH);
const staging = parseJsonc(STAGING_CONFIG_PATH);

test("producción y staging satisfacen contratos independientes", () => {
  assert.doesNotThrow(() => validateProductionConfig(production));
  assert.doesNotThrow(() => validateStagingConfig(staging));
  assert.notEqual(production.name, staging.name);
});

test("staging rechaza rutas, dominio productivo y bindings no autorizados", () => {
  for (const unsafeChange of [
    { name: "gisela-lentz-web" },
    { routes: [{ pattern: "giselalentz.com.ar", custom_domain: true }] },
    { route: "www.giselalentz.com.ar" },
    { custom_domain: true },
    {
      assets: {
        directory: "./dist",
        binding: "STATIC",
        run_worker_first: false,
      },
    },
    { d1_databases: [] },
    { kv_namespaces: [] },
    { r2_buckets: [] },
    { queues: {} },
    { durable_objects: { bindings: [] } },
    { hyperdrive: [] },
    { vars: { EXAMPLE: "not-used" } },
    { secrets_store_secrets: [] },
  ]) {
    assert.throws(() =>
      validateStagingConfig({ ...structuredClone(staging), ...unsafeChange }),
    );
  }
});

test("staging exige workers.dev estable, sin previews y observabilidad segura", () => {
  assert.throws(() =>
    validateStagingConfig({ ...structuredClone(staging), workers_dev: false }),
  );
  assert.throws(() =>
    validateStagingConfig({ ...structuredClone(staging), preview_urls: true }),
  );
  assert.throws(() =>
    validateStagingConfig({
      ...structuredClone(staging),
      observability: { enabled: true },
    }),
  );
});

test("producción exige el apex y deshabilita aliases públicos", () => {
  assert.throws(() =>
    validateProductionConfig({
      ...structuredClone(production),
      workers_dev: true,
    }),
  );
  assert.throws(() =>
    validateProductionConfig({
      ...structuredClone(production),
      preview_urls: true,
    }),
  );
  assert.throws(() =>
    validateProductionConfig({
      ...structuredClone(production),
      routes: [{ pattern: "www.giselalentz.com.ar", custom_domain: true }],
    }),
  );
});

test("los scripts no pueden omitir la configuración correspondiente", () => {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
  assert.doesNotThrow(() => validateDeploymentScripts(packageJson.scripts));
  assert.throws(() =>
    validateDeploymentScripts({
      ...packageJson.scripts,
      "deploy:cloudflare": "wrangler deploy",
    }),
  );
  assert.throws(() =>
    validateDeploymentScripts({
      ...packageJson.scripts,
      "deploy:cloudflare:staging": "wrangler deploy --config wrangler.jsonc",
    }),
  );
  assert.throws(() =>
    validateDeploymentScripts({
      ...packageJson.scripts,
      "deploy:cloudflare:dry":
        "node scripts/run-cloudflare-command.mjs production-dry && wrangler deploy",
    }),
  );
});

test("el wrapper rechaza overrides y fija config y entorno", () => {
  for (const [modeName, expected] of [
    [
      "production-dry",
      { config: "wrangler.jsonc", dryRun: true, local: false },
    ],
    [
      "staging-dry",
      { config: "wrangler.staging.jsonc", dryRun: true, local: false },
    ],
    [
      "preview",
      { config: "wrangler.staging.jsonc", dryRun: false, local: true },
    ],
  ]) {
    const mode = resolveCloudflareCommandMode([modeName]);
    assert.equal(mode.config, expected.config);
    assert.equal(Boolean(mode.dryRun), expected.dryRun);
    const argumentsList = createWranglerArguments(mode);
    assert.equal(
      argumentsList[argumentsList.indexOf("--config") + 1],
      expected.config,
    );
    assert.equal(argumentsList[argumentsList.indexOf("--env") + 1], "");
    assert.equal(argumentsList.includes("--dry-run"), expected.dryRun);
    assert.equal(argumentsList.includes("--local"), expected.local);
  }

  assert.throws(() => resolveCloudflareCommandMode([]));
  assert.throws(() => resolveCloudflareCommandMode(["staging"]));
  assert.throws(() => resolveCloudflareCommandMode(["production"]));
  assert.throws(() =>
    resolveCloudflareCommandMode(["staging", "--config", "wrangler.jsonc"]),
  );
});

test("el deploy real de staging fija target, strict mode y dry-run previo", () => {
  const dryRun = createStagingWranglerDeployArguments({ dryRun: true });
  const deploy = createStagingWranglerDeployArguments({ dryRun: false });

  for (const argumentsList of [dryRun, deploy]) {
    assert.equal(
      argumentsList[argumentsList.indexOf("--config") + 1],
      STAGING_CONFIG_PATH,
    );
    assert.equal(argumentsList[argumentsList.indexOf("--env") + 1], "");
    assert.equal(argumentsList.includes("--strict"), true);
    assert.equal(argumentsList.includes("wrangler.jsonc"), false);
    assert.equal(argumentsList.includes("--name"), false);
  }

  assert.equal(dryRun.includes("--dry-run"), true);
  assert.equal(deploy.includes("--dry-run"), false);
});
