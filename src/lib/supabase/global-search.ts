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
import { accentInsensitivePattern } from "~/lib/message-search";

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

  // Ignora acentos: «Lopez» encuentra «López». Ver `accentInsensitivePattern`.
  const namePattern = accentInsensitivePattern(
    trimmed,
    GLOBAL_SEARCH_MIN_LENGTH,
  );
  const digits = digitsOnly(trimmed);
  // Un teléfono se escribe con espacios y guiones; se busca por sus dígitos.
  const phonePattern = digits.length >= 4 ? `%${digits}%` : null;

  const contactsBase = () =>
    client
      .from("contacts")
      .select("id,name,phone_e164,coverage")
      .is("merged_into_contact_id", null)
      .order("name")
      .limit(PER_KIND_LIMIT);

  // Nombre y teléfono van en consultas separadas en lugar de un `.or()`:
  // así la expresión nunca pasa por la sintaxis de filtros combinados, donde
  // una coma o un paréntesis se leerían como parte del filtro.
  const [byName, byPhone, appointments, conversations] = await Promise.all([
    namePattern
      ? contactsBase().filter("name", "imatch", namePattern)
      : Promise.resolve({ data: [], error: null }),
    phonePattern
      ? contactsBase().ilike("phone_e164", phonePattern)
      : Promise.resolve({ data: [], error: null }),
    namePattern
      ? client
          .from("appointments")
          .select(
            "id,starts_at,status,contacts!appointments_contact_id_fkey(name),patient:contacts!appointments_patient_contact_id_fkey(name)",
          )
          .filter("contacts.name", "imatch", namePattern)
          .not("contacts", "is", null)
          .order("starts_at", { ascending: false })
          .limit(PER_KIND_LIMIT * 3)
      : Promise.resolve({ data: [], error: null }),
    namePattern
      ? client
          .from("conversations")
          .select(
            "id,unread_count,contacts!conversations_contact_id_fkey(name,phone_e164)",
          )
          .filter("contacts.name", "imatch", namePattern)
          .not("contacts", "is", null)
          .order("last_message_at", { ascending: false })
          .limit(PER_KIND_LIMIT)
      : Promise.resolve({ data: [], error: null }),
  ]);

  // Une las dos búsquedas de pacientes sin repetir a nadie.
  const contactRows = new Map<string, unknown>();
  for (const result of [byName, byPhone]) {
    if (result.error) continue;
    for (const row of result.data ?? []) {
      contactRows.set((row as { id: string }).id, row);
    }
  }
  const contacts = {
    error: byName.error && byPhone.error ? byName.error : null,
    data: [...contactRows.values()].slice(0, PER_KIND_LIMIT),
  };

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
        patient?: { name: string } | Array<{ name: string }> | null;
      };
      const contact = relation(row.contacts);
      if (!contact) continue;
      const patient = relation(row.patient);
      const date = new Date(row.starts_at);
      mapped.push({
        kind: "appointment",
        id: row.id,
        // El turno se busca y se muestra por quien se atiende.
        title: patient?.name ?? contact.name,
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
