import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { basename, relative, resolve, sep } from "node:path";

const DIST_DIRECTORY = resolve(process.cwd(), "dist");
const CANONICAL_ORIGIN = "https://giselalentz.com.ar";
const PRIVATE_ROBOTS = "noindex, nofollow, noarchive";
const EXPECTED_STAGING_WORKER = "gisela-lentz-web-staging";

function parseOrigin(argv) {
  const argumentsList = argv[0] === "--" ? argv.slice(1) : argv;
  assert.deepEqual(
    argumentsList.slice(0, 1),
    ["--origin"],
    "uso: node scripts/test-cloudflare-remote.mjs --origin https://<staging>.workers.dev",
  );
  assert.equal(argumentsList.length, 2, "se requiere únicamente --origin");
  const origin = new URL(argumentsList[1]);
  assert.equal(origin.protocol, "https:", "staging remoto debe usar HTTPS");
  assert.equal(origin.pathname, "/", "el origen no puede incluir un path");
  assert.equal(origin.search, "", "el origen no puede incluir query string");
  assert.equal(origin.hash, "", "el origen no puede incluir fragmento");
  assert.match(
    origin.hostname,
    new RegExp(
      `^${EXPECTED_STAGING_WORKER.replaceAll("-", "\\-")}\\.[a-z0-9-]+\\.workers\\.dev$`,
    ),
    "sólo se admite el hostname workers.dev estable del Worker de staging",
  );
  return origin.origin;
}

function filesBelow(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const pathname = resolve(directory, entry.name);
    return entry.isDirectory() ? filesBelow(pathname) : [pathname];
  });
}

function localAssetPath(pattern, excluded = []) {
  const pathname = filesBelow(DIST_DIRECTORY).find((candidate) => {
    const relativePath = relative(DIST_DIRECTORY, candidate)
      .split(sep)
      .join("/");
    return pattern.test(relativePath) && !excluded.includes(relativePath);
  });
  assert.ok(pathname, `no se encontró un asset local para ${pattern}`);
  return `/${relative(DIST_DIRECTORY, pathname).split(sep).join("/")}`;
}

async function request(origin, pathname) {
  const response = await fetch(new URL(pathname, origin), {
    redirect: "manual",
    headers: { "User-Agent": "gisela-lentz-cloudflare-phase-2b-smoke" },
  });
  return {
    status: response.status,
    headers: response.headers,
    body: await response.text(),
  };
}

function assertSecurityHeaders(response, pathname) {
  assert.equal(
    response.headers.get("content-security-policy"),
    "base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
    pathname,
  );
  assert.equal(
    response.headers.get("permissions-policy"),
    "camera=(), geolocation=(), microphone=()",
    pathname,
  );
  assert.equal(
    response.headers.get("referrer-policy"),
    "strict-origin-when-cross-origin",
    pathname,
  );
  assert.equal(
    response.headers.get("x-content-type-options"),
    "nosniff",
    pathname,
  );
  assert.equal(response.headers.get("x-frame-options"), "DENY", pathname);
}

function assertPrivateHeaders(response, pathname) {
  assert.equal(
    response.headers.get("cache-control"),
    "private, no-store, max-age=0",
    pathname,
  );
  assert.equal(response.headers.get("x-robots-tag"), PRIVATE_ROBOTS, pathname);
  assertSecurityHeaders(response, pathname);
}

function assertHashedAsset(pathname) {
  const filename = basename(pathname);
  assert.match(
    filename,
    /\.(?:css|js)$/,
    `${pathname} no es CSS ni JavaScript`,
  );

  const stem = filename.replace(/\.(?:css|js)$/, "");
  assert.ok(
    stem.split(/[-.]/).some((part) => /^[a-zA-Z0-9_]{6,}$/.test(part)),
    `${pathname} no parece un asset con hash`,
  );
}

const origin = parseOrigin(process.argv.slice(2));

const home = await request(origin, "/");
assert.equal(home.status, 200, "/");
assert.match(home.headers.get("content-type") ?? "", /text\/html/, "/");
assert.match(
  home.body,
  /<!doctype html|<html/i,
  "la landing no contiene HTML SSR",
);
assert.match(
  home.body,
  /<link(?=[^>]*rel="canonical")(?=[^>]*href="https:\/\/giselalentz\.com\.ar\/")[^>]*>/,
  "canonical incorrecto",
);
assert.equal(home.headers.get("x-robots-tag"), PRIVATE_ROBOTS, "/");
assert.equal(
  home.headers.get("cache-control"),
  "public, max-age=0, must-revalidate",
  "/",
);
assertSecurityHeaders(home, "/");

const privateStatusChains = [];
for (const pathname of ["/login", "/app"]) {
  const initialResponse = await request(origin, pathname);
  assertPrivateHeaders(initialResponse, pathname);

  let response = initialResponse;
  const statusChain = [initialResponse.status];
  if ([301, 302, 307, 308].includes(initialResponse.status)) {
    const location = initialResponse.headers.get("location");
    assert.equal(typeof location, "string", pathname);
    const redirectUrl = new URL(location, origin);
    assert.equal(redirectUrl.origin, origin, pathname);
    assert.equal(redirectUrl.pathname, `${pathname}/`, pathname);
    response = await request(
      origin,
      `${redirectUrl.pathname}${redirectUrl.search}`,
    );
    statusChain.push(response.status);
  }

  assert.equal(response.status, 200, pathname);
  assertPrivateHeaders(response, pathname);
  assert.match(
    response.headers.get("content-type") ?? "",
    /text\/html/,
    pathname,
  );
  assert.match(response.body, /<!doctype html|<html/i, pathname);
  privateStatusChains.push(`${pathname}: ${statusChain.join(" → ")}`);
}

const robots = await request(origin, "/robots.txt");
assert.equal(robots.status, 200, "/robots.txt");
assert.match(
  robots.body,
  /Sitemap: https:\/\/giselalentz\.com\.ar\/sitemap\.xml/,
  "robots.txt no usa el sitemap productivo",
);
assert.doesNotMatch(
  robots.body,
  /workers\.dev/i,
  "robots.txt contiene workers.dev",
);
assertSecurityHeaders(robots, "/robots.txt");

const sitemap = await request(origin, "/sitemap.xml");
assert.equal(sitemap.status, 200, "/sitemap.xml");
const sitemapLocations = [...sitemap.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map(
  ([, location]) => location,
);
assert.ok(sitemapLocations.length > 0, "sitemap.xml no contiene URLs");
for (const location of sitemapLocations) {
  assert.equal(new URL(location).origin, CANONICAL_ORIGIN, location);
  assert.doesNotMatch(location, /\/(?:app|login)(?:\/|$)/, location);
}
assert.doesNotMatch(
  sitemap.body,
  /workers\.dev/i,
  "sitemap.xml contiene workers.dev",
);

const manifest = await request(origin, "/manifest.json");
assert.equal(manifest.status, 200, "/manifest.json");
assert.doesNotThrow(
  () => JSON.parse(manifest.body),
  "manifest.json no es JSON válido",
);
assertSecurityHeaders(manifest, "/manifest.json");

const cssPath = localAssetPath(/\.css$/);
const jsPath = localAssetPath(/\.js$/, ["_worker.js"]);
const imagePath = localAssetPath(/\.(?:png|svg|webp)$/);

for (const pathname of [cssPath, jsPath]) {
  assertHashedAsset(pathname);
  const response = await request(origin, pathname);
  assert.equal(response.status, 200, pathname);
  assert.match(
    response.headers.get("cache-control") ?? "",
    /immutable/,
    pathname,
  );
  assertSecurityHeaders(response, pathname);
}

const image = await request(origin, imagePath);
assert.equal(image.status, 200, imagePath);
assertSecurityHeaders(image, imagePath);

for (const pathname of [
  "/_worker.js",
  "/_headers",
  "/_routes.json",
  "/.assetsignore",
]) {
  const response = await request(origin, pathname);
  assert.equal(response.status, 404, pathname);
}

const missing = await request(origin, "/__cloudflare-phase-2b-missing__");
assert.equal(missing.status, 404, "URL inexistente");
assert.equal(
  missing.headers.get("x-robots-tag"),
  PRIVATE_ROBOTS,
  "URL inexistente",
);

console.log(
  [
    `Smoke remoto OK: ${origin}`,
    "/: 200, SSR, canonical productivo, noindex, seguridad y caché OK",
    `/login y /app: ${privateStatusChains.join("; ")}; no-store y noindex OK (sin credenciales)`,
    "/robots.txt (contenido público completo):",
    robots.body.trimEnd(),
    "Interpretación robots: permite crawling de la landing y bloquea /login y /app; el header SSR noindex protege la landing de staging.",
    `/sitemap.xml: 200; ${sitemapLocations.length} URL(s), todas productivas y ninguna privada`,
    "/manifest.json: 200 y JSON válido",
    `CSS con hash: ${cssPath}`,
    `JavaScript con hash: ${jsPath}`,
    `Imagen: ${imagePath}`,
    "artefactos internos: 404",
    "URL inexistente: 404 y noindex",
  ].join("\n"),
);
