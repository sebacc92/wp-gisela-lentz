const SUPABASE_URL = "PUBLIC_SUPABASE_URL";
const SUPABASE_KEY = "PUBLIC_SUPABASE_PUBLISHABLE_KEY";

/** @param {Record<string, unknown>} environment */
export function assertPublicBuildEnv(environment) {
  const url = environment[SUPABASE_URL];
  const key = environment[SUPABASE_KEY];

  const missing = [SUPABASE_URL, SUPABASE_KEY].filter(
    (name) =>
      typeof environment[name] !== "string" || !environment[name].trim(),
  );
  if (missing.length) {
    throw new Error(
      `Falta configurar ${missing.join(" y ")} al compilar producción. ` +
        "Estas variables se incorporan al frontend durante el build; " +
        "agregarlas sólo al entorno del servidor no configura el navegador.",
    );
  }

  // Never include configuration values in errors: a mistaken key may be secret.
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "https:" ||
      !parsed.hostname ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      (parsed.pathname !== "" && parsed.pathname !== "/") ||
      url !== url.trim()
    ) {
      throw new Error("invalid URL");
    }
  } catch {
    throw new Error(`${SUPABASE_URL} debe ser la URL HTTPS base de Supabase.`);
  }

  if (/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) return;

  // Older projects can still use an anon JWT as their browser-safe API key.
  // This is a build-time role check, not a JWT signature verification.
  if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(key)) {
    try {
      const payload = JSON.parse(
        Buffer.from(key.split(".")[1], "base64url").toString("utf8"),
      );
      if (payload?.role === "anon") return;
    } catch {
      // Fall through to the same non-sensitive error for malformed JWTs.
    }
  }

  throw new Error(
    `${SUPABASE_KEY} debe ser una clave pública publishable o anon; ` +
      "nunca una clave secret o service_role.",
  );
}

/** @returns {import("vite").Plugin} */
export function publicBuildEnvGuard() {
  return {
    name: "public-supabase-build-env",
    apply: "build",
    configResolved(config) {
      if (config.command === "build" && config.mode === "production") {
        // Vite has already loaded envDir/.env files and process.env overrides.
        // Validate the values it will actually inline into import.meta.env.
        assertPublicBuildEnv(config.env);
      }
    },
  };
}
