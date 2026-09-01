import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PRODUCTION_CONFIG_PATH,
  STAGING_CONFIG_PATH,
  validateRepositoryCloudflareConfig,
} from "./check-cloudflare-config.mjs";

const RUNTIME_ENV_FILE = "config/cloudflare-runtime.env";
const MODES = Object.freeze({
  "production-dry": {
    command: "deploy",
    config: PRODUCTION_CONFIG_PATH,
    dryRun: true,
  },
  "staging-dry": {
    command: "deploy",
    config: STAGING_CONFIG_PATH,
    dryRun: true,
  },
  preview: {
    command: "dev",
    config: STAGING_CONFIG_PATH,
    local: true,
  },
});

function fail(message) {
  console.error(`Comando Cloudflare bloqueado: ${message}`);
  process.exit(1);
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) fail(`${command} no pudo iniciarse`);
  if (result.status !== 0) {
    fail(`${command} terminó con código ${result.status ?? "desconocido"}`);
  }
}

export function resolveCloudflareCommandMode(argumentsList) {
  const [modeName, ...extraArguments] = argumentsList;
  if (!Object.hasOwn(MODES, modeName) || extraArguments.length > 0) {
    throw new Error("modo inválido o argumentos adicionales no permitidos");
  }
  return MODES[modeName];
}

export function createWranglerArguments(mode) {
  const argumentsList = ["exec", "wrangler", mode.command];
  if (mode.dryRun) argumentsList.push("--dry-run");
  argumentsList.push("--config", mode.config, "--env", "");
  if (mode.local) argumentsList.push("--local");
  argumentsList.push("--env-file", RUNTIME_ENV_FILE);
  return argumentsList;
}

function execute(argumentsList) {
  let mode;
  try {
    mode = resolveCloudflareCommandMode(argumentsList);
  } catch (error) {
    fail(error instanceof Error ? error.message : "argumentos inválidos");
  }

  validateRepositoryCloudflareConfig();
  run("pnpm", ["run", "build:cloudflare"]);
  validateRepositoryCloudflareConfig();
  run("pnpm", createWranglerArguments(mode));
}

const isDirectExecution =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isDirectExecution) execute(process.argv.slice(2));
