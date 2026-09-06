import type { SupabaseClient } from "npm:@supabase/supabase-js@2.112.2";
import {
  formatOwnerAgenda,
  ownerAgendaRange,
  OWNER_TIMEZONE,
} from "./owner-access.ts";

export function activeOwnerAppointment(
  row: {
    status: string;
    deposit_status: string;
    hold_expires_at: string | null;
  },
  now = new Date(),
): boolean {
  if (row.status === "confirmed") return true;
  if (row.status !== "scheduled") return false;
  if (
    row.deposit_status !== "pending" &&
    row.deposit_status !== "proof_received"
  )
    return true;
  return (
    row.hold_expires_at !== null &&
    Date.parse(row.hold_expires_at) > now.getTime()
  );
}

export async function loadOwnerAgenda(args: {
  client: SupabaseClient;
  day: "today" | "tomorrow" | "week";
  now?: Date;
}): Promise<string> {
  const now = args.now ?? new Date();
  const range = ownerAgendaRange(args.day, now);
  const [appointments, connection, blocks] = await Promise.all([
    args.client
      .from("appointments")
      .select(
        "starts_at,status,hold_expires_at,coverage,deposit_status,contacts!appointments_contact_id_fkey(name)",
      )
      .gte("starts_at", range.from)
      .lt("starts_at", range.until)
      .in("status", ["scheduled", "confirmed"])
      .order("starts_at"),
    args.client
      .from("google_calendar_connections")
      .select("status,connection_generation,last_sync_completed_at")
      .eq("id", true)
      .maybeSingle(),
    args.client
      .from("google_calendar_external_events")
      .select("starts_at,ends_at,all_day,connection_generation")
      .eq("kind", "block")
      .eq("status", "active")
      .lt("starts_at", range.until)
      .gt("ends_at", range.from)
      .order("starts_at"),
  ]);
  if (appointments.error || connection.error || blocks.error)
    throw new Error("OWNER_AGENDA_UNAVAILABLE");
  const current = connection.data;
  const fresh =
    current?.status === "connected" &&
    current.last_sync_completed_at &&
    Date.parse(current.last_sync_completed_at) <= now.getTime() &&
    Date.parse(current.last_sync_completed_at) > now.getTime() - 5 * 60 * 1000;
  return formatOwnerAgenda({
    day: args.day,
    timezone: OWNER_TIMEZONE,
    appointments: (appointments.data ?? [])
      .filter((row) => activeOwnerAppointment(row, now))
      .map((row) => {
        const patient = Array.isArray(row.contacts)
          ? row.contacts[0]
          : row.contacts;
        return {
          startsAt: row.starts_at as string,
          patientName: (patient?.name as string) || "Sin nombre",
          patientPhone: null,
          coverage: row.coverage as string | null,
          service: null,
          depositStatus: row.deposit_status as string | null,
        };
      }),
    blocks: (blocks.data ?? [])
      .filter(
        (row) => row.connection_generation === current?.connection_generation,
      )
      .map((row) => ({
        startsAt: row.starts_at as string,
        endsAt: row.ends_at as string,
        allDay: row.all_day === true,
      })),
    calendarNeedsReview: !fresh,
  });
}
