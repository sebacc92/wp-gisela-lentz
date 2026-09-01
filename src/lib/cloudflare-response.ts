import { SITE_ORIGIN } from "../config/site.ts";

const PRIVATE_CACHE_CONTROL = "private, no-store, max-age=0";
const PUBLIC_CACHE_CONTROL = "public, max-age=0, must-revalidate";
const PRIVATE_ROBOTS = "noindex, nofollow, noarchive";
const PRODUCTION_HOSTNAME = new URL(SITE_ORIGIN).hostname;

export const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  "Permissions-Policy": "camera=(), geolocation=(), microphone=()",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
} as const;

export function isPrivateFrontendPath(pathname: string): boolean {
  return (
    pathname === "/login" ||
    pathname.startsWith("/login/") ||
    pathname === "/app" ||
    pathname.startsWith("/app/")
  );
}

export function isCanonicalProductionHostname(hostname: string): boolean {
  return hostname.toLowerCase() === PRODUCTION_HOSTNAME;
}

export function withCloudflareResponseHeaders(
  request: Request,
  response: Response,
): Response {
  const headers = new Headers(response.headers);

  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value);
  }

  const requestUrl = new URL(request.url);

  if (isPrivateFrontendPath(requestUrl.pathname)) {
    headers.set("Cache-Control", PRIVATE_CACHE_CONTROL);
    headers.set("X-Robots-Tag", PRIVATE_ROBOTS);
  } else {
    if (!isCanonicalProductionHostname(requestUrl.hostname)) {
      headers.set("X-Robots-Tag", PRIVATE_ROBOTS);
    }
    if (!headers.has("Cache-Control")) {
      headers.set("Cache-Control", PUBLIC_CACHE_CONTROL);
    }
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
