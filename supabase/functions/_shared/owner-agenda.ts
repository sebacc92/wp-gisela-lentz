import type { SupabaseClient } from "npm:@supabase/supabase-js@2.112.2";
import type { OwnerAgendaDay } from "./owner-agenda-period.ts";
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
  day: OwnerAgendaDay;
  now?: Date;
}): Promise<string> {
  const now = args.now ?? new Date();
  const range = ownerAgendaRange(args.day, now);
  let appointmentQuery = args.client
    .from("appointments")
    .select(
      "starts_at,status,hold_expires_at,coverage,deposit_status,contacts!appointments_contact_id_fkey(name)",
    )
    .gte("starts_at", range.from)
    .in("status", ["scheduled", "confirmed"])
    .order("starts_at");
  if (range.until) {
    appointmentQuery = appointmentQuery.lt("starts_at", range.until);
  } else {
    // A future list starts now, has no arbitrary week cutoff, and never claims
    // to include everything if the message/query limit is reached.
    appointmentQuery = appointmentQuery
      .or(
        `status.eq.confirmed,deposit_status.not.in.(pending,proof_received),hold_expires_at.gt.${now.toISOString()}`,
      )
      .limit(101);
  }
  const [appointments, connection, blocks] = await Promise.all([
    appointmentQuery,
    args.client
      .from("google_calendar_connections")
      .select("status,connection_generation,last_sync_completed_at")
      .eq("id", true)
      .maybeSingle(),
    range.until
      ? args.client
          .from("google_calendar_external_events")
          .select("starts_at,ends_at,all_day,connection_generation")
          .eq("kind", "block")
          .eq("status", "active")
          .lt("starts_at", range.until)
          .gt("ends_at", range.from)
          .order("starts_at")
      : Promise.resolve({ data: [], error: null }),
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
    now,
    timezone: OWNER_TIMEZONE,
    hasMore: args.day === "upcoming" && (appointments.data?.length ?? 0) > 100,
    appointments: (appointments.data ?? [])
      .slice(0, args.day === "upcoming" ? 100 : undefined)
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
