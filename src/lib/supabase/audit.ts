import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Lectura del registro de actividad para el visor de Configuración.
 *
 * Sólo lee lo que RLS ya permite a una persona ADMIN: `audit_logs` y
 * `webhook_events`. Las colas internas (`google_calendar_sync_jobs`,
 * `whatsapp_onboarding_outbox` y compañía) no tienen políticas y son
 * exclusivas de `service_role`: no se consultan desde el navegador, y el visor
 * lo dice en lugar de mostrar una lista vacía como si no hubiera pasado nada.
 */

export interface AuditLogEntry {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  actorName: string | null;
  createdAt: string;
  metadata: Record<string, unknown>;
}

export interface WebhookEventEntry {
  id: string;
  externalEventId: string;
  eventType: string;
  status: string;
  error: string | null;
  createdAt: string;
  processedAt: string | null;
}

export const AUDIT_PAGE_SIZE = 50;

function relation<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

export async function loadAuditLogs(
  client: SupabaseClient,
  options: { limit?: number; action?: string } = {},
): Promise<AuditLogEntry[]> {
  let query = client
    .from("audit_logs")
    .select(
      "id,action,entity_type,entity_id,created_at,metadata,profiles(full_name)",
    )
    .order("created_at", { ascending: false })
    .limit(options.limit ?? AUDIT_PAGE_SIZE);
  if (options.action) query = query.eq("action", options.action);

  const { data, error } = await query;
  if (error) throw error;

  return (data ?? []).map((raw) => {
    const row = raw as unknown as {
      id: string;
      action: string;
      entity_type: string;
      entity_id: string | null;
      created_at: string;
      metadata: unknown;
      profiles: { full_name: string } | Array<{ full_name: string }> | null;
    };
    return {
      id: row.id,
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      actorName: relation(row.profiles)?.full_name ?? null,
      createdAt: row.created_at,
      metadata:
        row.metadata && typeof row.metadata === "object"
          ? (row.metadata as Record<string, unknown>)
          : {},
    };
  });
}

export async function loadWebhookEvents(
  client: SupabaseClient,
  options: { limit?: number; status?: string } = {},
): Promise<WebhookEventEntry[]> {
  let query = client
    .from("webhook_events")
    .select(
      "id,external_event_id,event_type,status,error,created_at,processed_at",
    )
    .order("created_at", { ascending: false })
    .limit(options.limit ?? AUDIT_PAGE_SIZE);
  if (options.status) query = query.eq("status", options.status);

  const { data, error } = await query;
  if (error) throw error;

  return (data ?? []).map((raw) => {
    const row = raw as unknown as {
      id: string;
      external_event_id: string;
      event_type: string;
      status: string;
      error: string | null;
      created_at: string;
      processed_at: string | null;
    };
    return {
      id: row.id,
      externalEventId: row.external_event_id,
      eventType: row.event_type,
      status: row.status,
      error: row.error,
      createdAt: row.created_at,
      processedAt: row.processed_at,
    };
  });
}
