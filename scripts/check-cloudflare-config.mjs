import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

export const PRODUCTION_CONFIG_PATH = "wrangler.jsonc";
export const STAGING_CONFIG_PATH = "wrangler.staging.jsonc";
export const PRODUCTION_HOSTNAME = "giselalentz.com.ar";

const COMMON_CONFIG_KEYS = [
  "$schema",
  "assets",
  "compatibility_date",
  "main",
  "name",
  "observability",
  "preview_urls",
  "workers_dev",
];

const FORBIDDEN_BINDING_KEYS = new Set([
  "d1_databases",
  "durable_objects",
  "hyperdrive",
  "kv_namespaces",
  "queues",
  "r2_buckets",
  "secrets",
  "secrets_store_secrets",
  "vars",
]);

function assertExactKeys(value, expected, label) {
  assert.deepEqual(
    Object.keys(value).sort(),
    [...expected].sort(),
    `${label} contiene claves no permitidas o incompletas`,
  );
}

function assertNoForbiddenBindings(value, label) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    assert.equal(
      FORBIDDEN_BINDING_KEYS.has(key),
      false,
      `${label} no puede declarar ${key}`,
    );
    assertNoForbiddenBindings(child, label);
  }
}

function validateCommonConfig(config, expectedName, label) {
  assert.equal(config.name, expectedName, `${label}: name incorrecto`);
  assert.equal(
    config.main,
    "./dist/_worker.js",
    `${label}: entrypoint incorrecto`,
  );
  assert.equal(
    config.compatibility_date,
    "2026-08-31",
    `${label}: compatibility_date incorrecta`,
  );
  assert.deepEqual(
    config.assets,
    {
      directory: "./dist",
      binding: "ASSETS",
      run_worker_first: false,
    },
    `${label}: Static Assets debe usar únicamente ASSETS y dist`,
  );
  assert.deepEqual(
    config.observability,
    { enabled: false },
    `${label}: la observabilidad persistente debe estar deshabilitada`,
  );
  assertNoForbiddenBindings(config, label);
}

export function parseJsonc(pathname) {
  const source = readFileSync(pathname, "utf8");
  const parsed = ts.parseConfigFileTextToJson(pathname, source);
  if (parsed.error) {
    throw new Error(`${pathname} no es JSONC válido`);
  }
  assert.ok(
    parsed.config && typeof parsed.config === "object",
    `${pathname} no contiene un objeto`,
  );
  return parsed.config;
}

export function validateProductionConfig(config) {
  assertExactKeys(
    config,
    [...COMMON_CONFIG_KEYS, "routes"],
    "wrangler de producción",
  );
  validateCommonConfig(config, "gisela-lentz-web", "producción");
  assert.equal(
    config.workers_dev,
    false,
    "producción debe deshabilitar workers.dev",
  );
  assert.equal(
    config.preview_urls,
    false,
    "producción debe deshabilitar Preview URLs",
  );
  assert.deepEqual(
    config.routes,
    [{ pattern: PRODUCTION_HOSTNAME, custom_domain: true }],
    "producción debe tener únicamente el Custom Domain canónico",
  );
}

export function validateStagingConfig(config) {
  assertExactKeys(config, COMMON_CONFIG_KEYS, "wrangler de staging");
  validateCommonConfig(config, "gisela-lentz-web-staging", "staging");
  assert.equal(config.workers_dev, true, "staging debe habilitar workers.dev");
  assert.equal(
    config.preview_urls,
    false,
    "staging debe deshabilitar Preview URLs",
  );
  assert.equal("routes" in config, false, "staging no puede declarar routes");
  assert.equal("route" in config, false, "staging no puede declarar route");
  assert.equal(
    JSON.stringify(config).toLowerCase().includes(PRODUCTION_HOSTNAME),
    false,
    "staging no puede contener el hostname productivo",
  );
}

export function validateDeploymentScripts(scripts) {
  const expectedScripts = {
    deploy: "node scripts/run-cloudflare-command.mjs production-dry",
    "deploy:cloudflare":
      "node scripts/run-cloudflare-command.mjs production-dry",
    "deploy:cloudflare:dry":
      "node scripts/run-cloudflare-command.mjs production-dry",
    "deploy:cloudflare:production":
      "node scripts/deploy-cloudflare-production.mjs",
    "deploy:cloudflare:staging": "node scripts/deploy-cloudflare-staging.mjs",
    "deploy:cloudflare:staging:dry":
      "node scripts/run-cloudflare-command.mjs staging-dry",
    "preview:cloudflare": "node scripts/run-cloudflare-command.mjs preview",
  };

  for (const [name, expected] of Object.entries(expectedScripts)) {
    assert.equal(
      scripts[name],
      expected,
      `${name} debe usar exactamente el wrapper protegido`,
    );
  }
}

function validateEmptyRuntimeEnvironment() {
  const source = readFileSync("config/cloudflare-runtime.env", "utf8").replace(
    /\r\n/g,
    "\n",
  );
  assert.equal(
    source,
    "# Phases 1 and 2A have no Worker runtime variables or secrets.\n",
    "config/cloudflare-runtime.env debe conservar exactamente el placeholder seguro",
  );
}

export function validateRepositoryCloudflareConfig() {
  validateProductionConfig(parseJsonc(PRODUCTION_CONFIG_PATH));
  validateStagingConfig(parseJsonc(STAGING_CONFIG_PATH));
  const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
  validateDeploymentScripts(packageJson.scripts ?? {});
  validateEmptyRuntimeEnvironment();
}

const isDirectExecution =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isDirectExecution) {
  validateRepositoryCloudflareConfig();
  console.log(
    "Separación Cloudflare verificada: producción y staging usan configuraciones independientes",
  );
}
