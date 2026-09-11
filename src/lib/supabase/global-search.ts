import type { SupabaseClient } from "@supabase/supabase-js";
import { businessDateInput, formatBusinessDate } from "~/lib/date-time";
import {
  appointmentHref,
  conversationHref,
  compareAppointments,
  patientHref,
  GLOBAL_SEARCH_MIN_LENGTH,
  type GlobalSearchResult,
} from "~/lib/global-search";
import { escapeLikePattern } from "~/lib/message-search";

/**
 * Consulta de la búsqueda global.
 *
 * Busca en pacientes, turnos y conversaciones a la vez y devuelve poco de cada
 * uno: es un atajo para llegar a algo, no un listado. RLS sigue decidiendo qué
 * filas se ven.
 */

const PER_KIND_LIMIT = 5;

function relation<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}

export async function runGlobalSearch(
  client: SupabaseClient,
  query: string,
): Promise<GlobalSearchResult[]> {
  const trimmed = query.trim();
  if (trimmed.length < GLOBAL_SEARCH_MIN_LENGTH) return [];

  const pattern = `%${escapeLikePattern(trimmed)}%`;
  const digits = digitsOnly(trimmed);
  // Un teléfono se escribe con espacios y guiones; se busca por sus dígitos.
  const phonePattern = digits.length >= 4 ? `%${digits}%` : null;

  const contactFilter = phonePattern
    ? `name.ilike.${pattern},phone_e164.ilike.${phonePattern}`
    : `name.ilike.${pattern}`;

  const [contacts, appointments, conversations] = await Promise.all([
    client
      .from("contacts")
      .select("id,name,phone_e164,coverage")
      .or(contactFilter)
      .order("name")
      .limit(PER_KIND_LIMIT),
    client
      .from("appointments")
      .select("id,starts_at,status,contacts!appointments_contact_id_fkey(name)")
      .ilike("contacts.name", pattern)
      .not("contacts", "is", null)
      .order("starts_at", { ascending: false })
      .limit(PER_KIND_LIMIT * 3),
    client
      .from("conversations")
      .select(
        "id,unread_count,contacts!conversations_contact_id_fkey(name,phone_e164)",
      )
      .ilike("contacts.name", pattern)
      .not("contacts", "is", null)
      .order("last_message_at", { ascending: false })
      .limit(PER_KIND_LIMIT),
  ]);

  const results: GlobalSearchResult[] = [];

  if (!contacts.error) {
    for (const raw of contacts.data ?? []) {
      const row = raw as unknown as {
        id: string;
        name: string;
        phone_e164: string | null;
        coverage: string | null;
      };
      results.push({
        kind: "patient",
        id: row.id,
        title: row.name,
        subtitle:
          [
            row.phone_e164,
            row.coverage === "ioma"
              ? "IOMA"
              : row.coverage === "particular"
                ? "Particular"
                : null,
          ]
            .filter(Boolean)
            .join(" · ") || "Sin teléfono",
        href: patientHref(row.id),
      });
    }
  }

  if (!appointments.error) {
    const mapped: GlobalSearchResult[] = [];
    for (const raw of appointments.data ?? []) {
      const row = raw as unknown as {
        id: string;
        starts_at: string;
        status: string;
        contacts: { name: string } | Array<{ name: string }> | null;
      };
      const contact = relation(row.contacts);
      if (!contact) continue;
      const date = new Date(row.starts_at);
      mapped.push({
        kind: "appointment",
        id: row.id,
        title: contact.name,
        subtitle: formatBusinessDate(date, {
          dateStyle: "medium",
          timeStyle: "short",
        }),
        href: appointmentHref(row.id, businessDateInput(date)),
        startsAt: row.starts_at,
      });
    }
    mapped.sort((a, b) => compareAppointments(a, b));
    results.push(...mapped.slice(0, PER_KIND_LIMIT));
  }

  if (!conversations.error) {
    for (const raw of conversations.data ?? []) {
      const row = raw as unknown as {
        id: string;
        unread_count: number;
        contacts:
          | { name: string; phone_e164: string | null }
          | Array<{ name: string; phone_e164: string | null }>
          | null;
      };
      const contact = relation(row.contacts);
      if (!contact) continue;
      const unread = Number(row.unread_count ?? 0);
      results.push({
        kind: "conversation",
        id: row.id,
        title: contact.name,
        subtitle:
          unread > 0
            ? `${unread} sin leer`
            : (contact.phone_e164 ?? "Conversación"),
        href: conversationHref(row.id),
      });
    }
  }

  return results;
}
