import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  STAGING_CONFIG_PATH,
  validateRepositoryCloudflareConfig,
} from "./check-cloudflare-config.mjs";

const RUNTIME_ENV_FILE = "config/cloudflare-runtime.env";

function fail(message) {
  console.error(`Deploy de staging bloqueado: ${message}`);
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

function assertCleanWorktree() {
  const result = spawnSync(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  if (result.error || result.status !== 0) {
    fail("no se pudo comprobar el estado de Git");
  }
  if (result.stdout.trim()) {
    fail("el worktree debe estar completamente limpio");
  }
}

export function createStagingWranglerDeployArguments({ dryRun }) {
  const args = [
    "exec",
    "wrangler",
    "deploy",
    "--strict",
    "--config",
    STAGING_CONFIG_PATH,
    "--env",
    "",
    "--env-file",
    RUNTIME_ENV_FILE,
  ];
  if (dryRun) args.splice(4, 0, "--dry-run");
  return args;
}

function execute(argumentsList) {
  if (argumentsList.length !== 0) {
    fail("no se permiten argumentos adicionales");
  }

  validateRepositoryCloudflareConfig();
  assertCleanWorktree();

  run("pnpm", ["run", "build:cloudflare"]);
  validateRepositoryCloudflareConfig();
  assertCleanWorktree();

  run("pnpm", createStagingWranglerDeployArguments({ dryRun: true }));
  validateRepositoryCloudflareConfig();
  assertCleanWorktree();

  run("pnpm", createStagingWranglerDeployArguments({ dryRun: false }));
}

const isDirectExecution =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isDirectExecution) execute(process.argv.slice(2));
