export type AppRole = "ADMIN" | "OPERADOR";

export interface AdminAccessProfile {
  active?: unknown;
  role?: unknown;
}

/**
 * UI guards are intentionally conservative. The database and Edge Functions
 * remain the authorization boundary for data and mutations; this helper keeps
 * administrative navigation and pages from rendering before the profile is
 * known to be active and administrative.
 */
export function isAdminProfile(profile: AdminAccessProfile | null | undefined) {
  return profile?.active === true && profile.role === "ADMIN";
}
