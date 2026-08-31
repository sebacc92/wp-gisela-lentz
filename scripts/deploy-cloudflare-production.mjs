import { spawnSync } from "node:child_process";

import {
  PRODUCTION_CONFIG_PATH,
  PRODUCTION_HOSTNAME,
  validateRepositoryCloudflareConfig,
} from "./check-cloudflare-config.mjs";

function fail(message) {
  console.error(`Deploy de producción bloqueado: ${message}`);
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

if (process.argv.length !== 2) {
  fail("no se permiten argumentos adicionales");
}

if (process.env.CONFIRM_CLOUDFLARE_PRODUCTION !== PRODUCTION_HOSTNAME) {
  fail("falta la confirmación productiva exacta requerida");
}

validateRepositoryCloudflareConfig();
assertCleanWorktree();

for (const [command, args] of [
  ["pnpm", ["run", "lint"]],
  ["pnpm", ["run", "test:automation"]],
  ["pnpm", ["run", "build.types:web"]],
  ["pnpm", ["run", "build.types:functions"]],
  ["pnpm", ["run", "build"]],
  ["pnpm", ["run", "test:cloudflare"]],
  [
    "pnpm",
    [
      "exec",
      "wrangler",
      "deploy",
      "--dry-run",
      "--config",
      PRODUCTION_CONFIG_PATH,
      "--env",
      "",
      "--env-file",
      "config/cloudflare-runtime.env",
    ],
  ],
]) {
  run(command, args);
}

validateRepositoryCloudflareConfig();
assertCleanWorktree();

run("pnpm", [
  "exec",
  "wrangler",
  "deploy",
  "--config",
  PRODUCTION_CONFIG_PATH,
  "--env",
  "",
  "--env-file",
  "config/cloudflare-runtime.env",
]);
