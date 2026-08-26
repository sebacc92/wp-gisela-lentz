import {
  createClient,
  type SupabaseClient,
  type User,
} from "npm:@supabase/supabase-js@2.112.2";

function firstNamedKey(variableName: string): string | undefined {
  const raw = Deno.env.get(variableName);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, string>;
    return Object.values(parsed).find(Boolean);
  } catch {
    return undefined;
  }
}

export function getServiceKey(): string {
  const key =
    Deno.env.get("SUPABASE_SECRET_KEY") ??
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
    firstNamedKey("SUPABASE_SECRET_KEYS");
  if (!key) throw new Error("SUPABASE_SERVICE_KEY_MISSING");
  return key;
}

export function getPublishableKey(): string {
  const key =
    Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ??
    Deno.env.get("SUPABASE_ANON_KEY") ??
    firstNamedKey("SUPABASE_PUBLISHABLE_KEYS");
  if (!key) throw new Error("SUPABASE_PUBLISHABLE_KEY_MISSING");
  return key;
}

export function createServiceClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  if (!url) throw new Error("SUPABASE_URL_MISSING");
  return createClient(url, getServiceKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export interface AuthorizedUser {
  user: User;
  profile: { id: string; full_name: string; role: "ADMIN" | "OPERADOR" };
}

export async function authorizeUser(
  request: Request,
  client = createServiceClient(),
): Promise<AuthorizedUser> {
  const header = request.headers.get("authorization") ?? "";
  const token = header.replace(/^Bearer\s+/i, "").trim();
  if (!token) throw new Error("UNAUTHORIZED");

  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) throw new Error("UNAUTHORIZED");

  const { data: profile, error: profileError } = await client
    .from("profiles")
    .select("id,full_name,role,active")
    .eq("id", data.user.id)
    .single();

  if (profileError || !profile?.active) throw new Error("UNAUTHORIZED");
  return {
    user: data.user,
    profile: {
      id: profile.id as string,
      full_name: profile.full_name as string,
      role: profile.role as "ADMIN" | "OPERADOR",
    },
  };
}
