import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let browserClient: SupabaseClient | undefined;

export function isSupabaseConfigured(): boolean {
  return Boolean(
    import.meta.env.PUBLIC_SUPABASE_URL &&
    import.meta.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  );
}

export function getSupabaseClient(): SupabaseClient {
  if (!isSupabaseConfigured()) {
    throw new Error("Supabase no está configurado.");
  }

  if (!browserClient) {
    browserClient = createClient(
      import.meta.env.PUBLIC_SUPABASE_URL,
      import.meta.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY,
      {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
        },
        realtime: {
          params: { eventsPerSecond: 10 },
        },
      },
    );
  }

  return browserClient;
}
