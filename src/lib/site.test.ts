import assert from "node:assert/strict";
import test from "node:test";

import { getCanonicalUrl, SITE_ORIGIN } from "../config/site.ts";
import {
  isCanonicalProductionHostname,
  isPrivateFrontendPath,
  SECURITY_HEADERS,
  withCloudflareResponseHeaders,
} from "./cloudflare-response.ts";

test("el origen canónico es fijo aunque el request llegue por otro host", () => {
  assert.equal(SITE_ORIGIN, "https://giselalentz.com.ar");
  assert.equal(getCanonicalUrl("/"), "https://giselalentz.com.ar/");
  assert.equal(
    getCanonicalUrl("/privacy-policy"),
    "https://giselalentz.com.ar/privacy-policy",
  );
  assert.equal(
    getCanonicalUrl("login?host=preview.example#fragment"),
    "https://giselalentz.com.ar/login%3Fhost=preview.example%23fragment",
  );
});

test("sólo login y app, con sus subrutas, se consideran privadas", () => {
  for (const pathname of ["/login", "/login/reset", "/app", "/app/inbox"]) {
    assert.equal(isPrivateFrontendPath(pathname), true, pathname);
  }
  for (const pathname of ["/", "/application", "/login-public"]) {
    assert.equal(isPrivateFrontendPath(pathname), false, pathname);
  }
});

test("sólo el hostname canónico se considera producción", () => {
  assert.equal(isCanonicalProductionHostname("giselalentz.com.ar"), true);
  assert.equal(isCanonicalProductionHostname("GISELALENTZ.COM.AR"), true);
  for (const hostname of [
    "gisela-lentz-web-staging.example.workers.dev",
    "version-gisela-lentz-web-staging.example.workers.dev",
    "localhost",
    "127.0.0.1",
    "www.giselalentz.com.ar",
  ]) {
    assert.equal(isCanonicalProductionHostname(hostname), false, hostname);
  }
});

test("las respuestas SSR productivas reciben seguridad sin noindex global", () => {
  const response = withCloudflareResponseHeaders(
    new Request("https://giselalentz.com.ar/"),
    new Response("ok", { headers: { "Content-Type": "text/plain" } }),
  );

  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    assert.equal(response.headers.get(name), value);
  }
  assert.equal(
    response.headers.get("Cache-Control"),
    "public, max-age=0, must-revalidate",
  );
  assert.equal(response.headers.get("X-Robots-Tag"), null);
});

test("workers.dev, previews, localhost y www nunca son indexables", () => {
  for (const url of [
    "https://gisela-lentz-web-staging.example.workers.dev/",
    "https://version-gisela-lentz-web-staging.example.workers.dev/",
    "http://localhost:8787/",
    "http://127.0.0.1:8787/",
    "https://www.giselalentz.com.ar/",
  ]) {
    const response = withCloudflareResponseHeaders(
      new Request(url),
      new Response("public"),
    );
    assert.equal(
      response.headers.get("X-Robots-Tag"),
      "noindex, nofollow, noarchive",
      url,
    );
    assert.equal(
      response.headers.get("Cache-Control"),
      "public, max-age=0, must-revalidate",
      url,
    );
  }
});

test("login y app no se almacenan ni se indexan", () => {
  for (const hostname of [
    "giselalentz.com.ar",
    "gisela-lentz-web-staging.example.workers.dev",
    "version-gisela-lentz-web-staging.example.workers.dev",
    "localhost",
    "www.giselalentz.com.ar",
  ]) {
    for (const pathname of ["/login", "/login/reset", "/app", "/app/inbox"]) {
      const response = withCloudflareResponseHeaders(
        new Request(`https://${hostname}${pathname}`),
        new Response("private"),
      );
      assert.equal(
        response.headers.get("Cache-Control"),
        "private, no-store, max-age=0",
        `${hostname}${pathname}`,
      );
      assert.equal(
        response.headers.get("X-Robots-Tag"),
        "noindex, nofollow, noarchive",
        `${hostname}${pathname}`,
      );
    }
  }
});
