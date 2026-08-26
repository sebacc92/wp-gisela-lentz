const defaultOrigins = ["http://localhost:5173", "http://127.0.0.1:5173"];

function allowedOrigins(): string[] {
  const raw = Deno.env.get("APP_ALLOWED_ORIGINS") ?? "";
  const configured = raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => {
      if (!value) return false;
      try {
        const parsed = new URL(value);
        const localHttp =
          parsed.protocol === "http:" &&
          (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
        return (
          (parsed.protocol === "https:" || localHttp) &&
          parsed.origin === value &&
          parsed.username === "" &&
          parsed.password === "" &&
          parsed.pathname === "/" &&
          parsed.search === "" &&
          parsed.hash === ""
        );
      } catch {
        return false;
      }
    });
  // Local defaults are development-only. Once production config is present,
  // even a malformed allowlist fails closed instead of re-enabling localhost.
  return raw.trim() === "" ? defaultOrigins : [...new Set(configured)];
}

export function isRequestOriginAllowed(request: Request): boolean {
  const origin = request.headers.get("origin")?.trim() ?? "";
  return origin !== "" && allowedOrigins().includes(origin);
}

export function corsHeaders(request: Request): HeadersInit {
  const origin = request.headers.get("origin") ?? "";
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers":
      "authorization, apikey, content-type, x-client-info, x-cron-secret, x-google-calendar-cron-secret, x-internal-secret, x-hub-signature-256",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    Vary: "Origin",
  };
  if (origin && allowedOrigins().includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

export function jsonResponse(
  request: Request,
  body: unknown,
  status = 200,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(request),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export function optionsResponse(request: Request): Response {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

export function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 500);
  return "Error inesperado";
}
