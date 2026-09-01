import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";

const root = process.cwd();
const dist = resolve(root, "dist");
const port = 18700 + Math.floor(Math.random() * 500);
const origin = `http://127.0.0.1:${port}`;
const output = [];
const PRODUCTION_HOSTNAME = "giselalentz.com.ar";
const PRIVATE_ROBOTS = "noindex, nofollow, noarchive";

function parseArguments(argv) {
  const options = { config: "wrangler.jsonc", label: "production" };
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    assert.ok(value, `falta el valor de ${name}`);
    if (name === "--config") options.config = value;
    else if (name === "--label") options.label = value;
    else throw new Error(`argumento no soportado: ${name}`);
  }
  assert.ok(
    ["wrangler.jsonc", "wrangler.staging.jsonc"].includes(options.config),
    "el smoke sólo admite las configuraciones Cloudflare versionadas",
  );
  return options;
}

const options = parseArguments(process.argv.slice(2));
const simulatedHostname =
  options.config === "wrangler.jsonc"
    ? PRODUCTION_HOSTNAME
    : "gisela-lentz-web-staging.example.workers.dev";
const simulatedHostIsIndexable = simulatedHostname === PRODUCTION_HOSTNAME;

function filesBelow(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? filesBelow(path) : [path];
  });
}

function assetPath(pattern, excluded = []) {
  const path = filesBelow(dist).find(
    (candidate) =>
      pattern.test(candidate) && !excluded.includes(relative(dist, candidate)),
  );
  assert.ok(path, `no se encontró asset para ${pattern}`);
  return `/${relative(dist, path).split(sep).join("/")}`;
}

function request(pathname) {
  return new Promise((resolveRequest, reject) => {
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        path: pathname,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolveRequest({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function waitUntilReady() {
  const deadline = Date.now() + 60_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await request("/");
      if (response.status > 0) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`Wrangler no inició a tiempo: ${String(lastError ?? "")}`);
}

function assertSecurityHeaders(response, pathname) {
  assert.equal(
    response.headers["content-security-policy"],
    "base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
    pathname,
  );
  assert.equal(
    response.headers["permissions-policy"],
    "camera=(), geolocation=(), microphone=()",
    pathname,
  );
  assert.equal(
    response.headers["referrer-policy"],
    "strict-origin-when-cross-origin",
    pathname,
  );
  assert.equal(response.headers["x-content-type-options"], "nosniff", pathname);
  assert.equal(response.headers["x-frame-options"], "DENY", pathname);
}

function assertPrivateHeaders(response, pathname) {
  assert.equal(
    response.headers["cache-control"],
    "private, no-store, max-age=0",
    pathname,
  );
  assert.equal(response.headers["x-robots-tag"], PRIVATE_ROBOTS, pathname);
  assertSecurityHeaders(response, pathname);
}

function assertCanonical(response, label) {
  assertBodyMatches(
    response,
    /<link(?=[^>]*rel="canonical")(?=[^>]*href="https:\/\/giselalentz\.com\.ar\/")[^>]*>/,
    `${label}: canonical incorrecto`,
  );
}

function assertBodyMatches(response, pattern, message) {
  if (!pattern.test(response.body)) throw new Error(message);
}

function assertBodyOmits(response, pattern, message) {
  if (pattern.test(response.body)) throw new Error(message);
}

const wrangler = spawn(
  "pnpm",
  [
    "exec",
    "wrangler",
    "dev",
    "--config",
    options.config,
    "--env",
    "",
    "--local",
    "--host",
    simulatedHostname,
    "--env-file",
    "config/cloudflare-runtime.env",
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
    "--log-level",
    "warn",
    "--show-interactive-dev-session=false",
  ],
  { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
);

for (const stream of [wrangler.stdout, wrangler.stderr]) {
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    if (output.join("").length < 20_000) output.push(chunk);
  });
}

try {
  await waitUntilReady();

  // Wrangler derives Request.url from --host in local mode; changing only the
  // incoming Host header does not simulate a different Worker hostname.
  const home = await request("/");
  assert.equal(home.status, 200, options.label);
  assertCanonical(home, options.label);
  assertSecurityHeaders(home, options.label);
  assert.equal(
    home.headers["cache-control"],
    "public, max-age=0, must-revalidate",
    options.label,
  );
  assert.equal(
    home.headers["x-robots-tag"],
    simulatedHostIsIndexable ? undefined : PRIVATE_ROBOTS,
    options.label,
  );
  assertBodyOmits(
    home,
    /gisela-lentz-wp\.vercel\.app/,
    "la landing contiene el hostname productivo anterior",
  );
  assertBodyMatches(
    home,
    /property="og:url" content="https:\/\/giselalentz\.com\.ar\/"/,
    "Open Graph no usa el origen canónico",
  );
  assertBodyMatches(
    home,
    /property="og:image" content="https:\/\/giselalentz\.com\.ar\/brand\//,
    "la imagen social no usa el origen canónico",
  );
  for (const schemaType of ["Dentist", "Person", "WebSite", "FAQPage"]) {
    assertBodyMatches(
      home,
      new RegExp(`"@type":"${schemaType}"`),
      `JSON-LD no contiene ${schemaType}`,
    );
  }
  assertSecurityHeaders(home, "/");

  const robots = await request("/robots.txt");
  assert.equal(robots.status, 200);
  assertBodyMatches(
    robots,
    /Sitemap: https:\/\/giselalentz\.com\.ar\/sitemap\.xml/,
    "robots.txt no declara el sitemap canónico",
  );
  assertBodyOmits(
    robots,
    /vercel\.app/,
    "robots.txt conserva un hostname Vercel",
  );
  assertSecurityHeaders(robots, "/robots.txt");

  const sitemap = await request("/sitemap.xml");
  assert.equal(sitemap.status, 200);
  assertBodyMatches(
    sitemap,
    /<loc>https:\/\/giselalentz\.com\.ar\/<\/loc>/,
    "sitemap.xml no contiene el origen canónico",
  );
  assertBodyOmits(
    sitemap,
    /\/(?:app|login)(?:\/|<)/,
    "sitemap.xml contiene una ruta privada",
  );
  assertBodyOmits(
    sitemap,
    /vercel\.app/,
    "sitemap.xml conserva un hostname Vercel",
  );

  const manifest = await request("/manifest.json");
  assert.equal(manifest.status, 200);
  assertSecurityHeaders(manifest, "/manifest.json");

  for (const pathname of ["/login", "/app", "/app/inbox"]) {
    const initialResponse = await request(pathname);
    assertPrivateHeaders(initialResponse, pathname);

    let response = initialResponse;
    if ([301, 302, 307, 308].includes(initialResponse.status)) {
      const location = initialResponse.headers.location;
      assert.equal(typeof location, "string", pathname);
      const redirectUrl = new URL(location, origin);
      assert.equal(redirectUrl.origin, origin, pathname);
      response = await request(`${redirectUrl.pathname}${redirectUrl.search}`);
    }

    assert.equal(response.status, 200, pathname);
    assertPrivateHeaders(response, pathname);
    assertBodyMatches(
      response,
      /<meta[^>]*name="robots"[^>]*content="noindex, nofollow, noarchive"/,
      `${pathname} no contiene metadata robots privada`,
    );
    assertSecurityHeaders(response, pathname);
  }

  const cssPath = assetPath(/\.css$/);
  const jsPath = assetPath(/\.js$/, ["_worker.js"]);
  const imagePath = assetPath(/\.(?:png|svg|webp)$/);

  for (const pathname of [cssPath, jsPath]) {
    const response = await request(pathname);
    assert.equal(response.status, 200, pathname);
    assert.match(
      response.headers["cache-control"] ?? "",
      /immutable/,
      pathname,
    );
    assertSecurityHeaders(response, pathname);
  }

  for (const pathname of [
    imagePath,
    "/images/dental-login.webp",
    "/images/dental-dashboard.webp",
  ]) {
    const image = await request(pathname);
    assert.equal(image.status, 200, pathname);
    assertSecurityHeaders(image, pathname);
  }

  for (const pathname of [
    "/_worker.js",
    "/_routes.json",
    "/_headers",
    "/.assetsignore",
  ]) {
    const response = await request(pathname);
    assert.equal(response.status, 404, pathname);
  }

  console.log(
    [
      `Wrangler local smoke ${options.label} OK (${origin})`,
      `config: ${options.config}`,
      `hostname simulado: ${simulatedHostname} (${simulatedHostIsIndexable ? "indexable" : "noindex"})`,
      "/, /robots.txt, /sitemap.xml, /manifest.json, /login, /app y /app/inbox: OK",
      `CSS: ${cssPath}`,
      `JS: ${jsPath}`,
      `imágenes: ${imagePath} y fondos de login/panel`,
      "artefactos internos: no descargables",
    ].join("\n"),
  );
} catch (error) {
  console.error(output.join("").slice(-20_000));
  throw error;
} finally {
  wrangler.kill("SIGTERM");
  await new Promise((resolveExit) => {
    if (wrangler.exitCode !== null) return resolveExit();
    wrangler.once("exit", resolveExit);
    setTimeout(() => {
      wrangler.kill("SIGKILL");
      resolveExit();
    }, 5_000).unref();
  });
}
