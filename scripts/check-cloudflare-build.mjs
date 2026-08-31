import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { gzipSync } from "node:zlib";

const root = process.cwd();
const dist = resolve(root, "dist");
const server = resolve(root, "server");

function filesBelow(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? filesBelow(path) : [path];
  });
}

function requireFile(pathname) {
  const path = resolve(root, pathname);
  assert.equal(existsSync(path), true, `falta ${pathname}`);
  assert.equal(statSync(path).isFile(), true, `${pathname} no es un archivo`);
  return path;
}

const workerEntry = requireFile("dist/_worker.js");
requireFile("server/entry.cloudflare-pages.js");
const assetsIgnorePath = requireFile("dist/.assetsignore");
const runtimeEnvPath = requireFile("config/cloudflare-runtime.env");
requireFile("dist/_headers");
requireFile("dist/robots.txt");
requireFile("dist/sitemap.xml");
requireFile("dist/manifest.json");

const assetsIgnore = readFileSync(assetsIgnorePath, "utf8");
const runtimeEnvAssignments = readFileSync(runtimeEnvPath, "utf8")
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"));
assert.deepEqual(
  runtimeEnvAssignments,
  [],
  "config/cloudflare-runtime.env debe permanecer sin asignaciones en estas fases",
);

for (const reserved of [
  "_worker.js",
  "_routes.json",
  "_headers",
  "_redirects",
  ".assetsignore",
]) {
  assert.match(
    assetsIgnore,
    new RegExp(`^${reserved.replaceAll(".", "\\.")}$`, "m"),
    `${reserved} debe quedar excluido de los assets publicados`,
  );
}

const distFiles = filesBelow(dist);
const serverFiles = filesBelow(server).filter((path) => path.endsWith(".js"));
assert.equal(
  existsSync(resolve(dist, "_routes.json")),
  false,
  "el build de Workers no debe generar _routes.json",
);
assert.equal(
  distFiles.some((path) => path.endsWith(".html")),
  false,
  "el build SSR no debe publicar HTML que omita el Worker",
);
assert.equal(
  distFiles.some((path) => path.endsWith(".css")),
  true,
  "el build debe contener CSS",
);
assert.equal(
  distFiles.some((path) => path.endsWith(".js") && path !== workerEntry),
  true,
  "el build debe contener JavaScript de cliente",
);
assert.equal(
  distFiles.some((path) => /\.(?:png|svg|webp)$/.test(path)),
  true,
  "el build debe contener imágenes",
);

const runtimeFiles = [workerEntry, ...serverFiles];
const runtimeSource = runtimeFiles
  .map((path) => readFileSync(path, "utf8"))
  .join("\n");
const generatedTextFiles = [
  ...runtimeFiles,
  ...distFiles.filter((path) => /\.(?:css|js|json|txt|xml)$/.test(path)),
];
const generatedSources = generatedTextFiles.map((path) =>
  readFileSync(path, "utf8"),
);

for (const [label, pattern] of [
  [
    "imports de APIs Deno",
    /(?:from|import\()[\s(]*["'](?:deno:|https:\/\/deno\.land)|\bnpm:/,
  ],
  ["código de Supabase Functions", /supabase\/functions\//],
  ["hostname productivo de Vercel", /https:\/\/gisela-lentz-wp\.vercel\.app/],
]) {
  if (generatedSources.some((source) => pattern.test(source))) {
    throw new Error(`el Worker contiene ${label}`);
  }
}

for (const secretName of [
  "AUTOMATION_INTERNAL_SECRET",
  "GOOGLE_CALENDAR_CLIENT_SECRET",
  "META_APP_SECRET",
  "META_WEBHOOK_VERIFY_TOKEN",
  "OPENAI_API_KEY",
  "REMINDER_CRON_SECRET",
  "SUPABASE_SECRET_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "WHATSAPP_ACCESS_TOKEN",
  "WHATSAPP_AUTOMATION_OUTBOX_RECOVERY_SECRET",
  "WHATSAPP_COEXISTENCE_INTERNAL_SECRET",
  "WHATSAPP_COEXISTENCE_RECOVERY_SECRET",
]) {
  if (generatedSources.some((source) => source.includes(secretName))) {
    throw new Error(`el Worker no debe referenciar ${secretName}`);
  }
}

if (
  generatedSources.some((source) =>
    /\b[A-Z][A-Z0-9_]*(?:_API_KEY|_PASSWORD|_PRIVATE_KEY|_SECRET|_TOKEN)\b/.test(
      source,
    ),
  )
) {
  throw new Error(
    "el Worker contiene un identificador de secreto no permitido",
  );
}

assert.match(
  readFileSync(workerEntry, "utf8"),
  /entry\.cloudflare-pages/,
  "_worker.js debe importar el entry generado por el adaptador instalado",
);

const runtimeBytes = runtimeFiles.reduce(
  (total, path) => total + statSync(path).size,
  0,
);
const runtimeGzipBytes = gzipSync(runtimeSource).byteLength;
const assetBytes = distFiles.reduce(
  (total, path) => total + statSync(path).size,
  0,
);

console.log(
  [
    "Cloudflare build verificado",
    `runtime modules: ${runtimeFiles.length}`,
    `runtime source: ${runtimeBytes} bytes`,
    `runtime source gzip combinado: ${runtimeGzipBytes} bytes`,
    `static assets: ${distFiles.length} archivos / ${assetBytes} bytes`,
    `assets root: ${relative(root, dist).split(sep).join("/")}`,
  ].join("\n"),
);
