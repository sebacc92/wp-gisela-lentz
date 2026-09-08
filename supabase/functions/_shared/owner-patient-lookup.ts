import type { SupabaseClient } from "npm:@supabase/supabase-js@2.112.2";
import { formatOwnerPatient, OWNER_TIMEZONE } from "./owner-access.ts";
import {
  matchOwnerPatients,
  normalizePatientName,
  type OwnerPatientCandidate,
} from "./owner-patient-matching.ts";

const PAGE_SIZE = 1000;
const MAX_DIRECTORY_SIZE = 10_000;
const CHOICE_TTL_MS = 10 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AMBIGUOUS_NAME_REPLY =
  "Hay más de una ficha con el mismo nombre. Para no confundirme de paciente, revisá cuál corresponde en el sistema interno.";
const STALE_PATIENT_REPLY =
  'La ficha cambió o ya no está disponible. Pedime "datos de" seguido del nombre para buscar de nuevo.';

export interface OwnerPatientChoice {
  ownerPhone: string;
  conversationId: string;
  createdAt: string;
  expiresAt: string;
  query: string;
  candidates: OwnerPatientCandidate[];
}

export interface OwnerPatientLookupReply {
  reply: string;
  pending: OwnerPatientChoice | null;
}

function plainName(name: string): string {
  return name.replace(/[\r\n\t]+/g, " ").trim().slice(0, 120);
}

function hasHomonym(
  offered: OwnerPatientCandidate[],
  directory: OwnerPatientCandidate[],
): boolean {
  return offered.some((item) => {
    const name = normalizePatientName(item.name);
    const ids = new Set(
      directory.filter((row) => normalizePatientName(row.name) === name).map((
        row,
      ) => row.id),
    );
    return ids.size > 1;
  });
}

function candidate(value: unknown): value is OwnerPatientCandidate {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return typeof row.id === "string" && UUID.test(row.id) &&
    typeof row.name === "string" && row.name.trim().length > 0 &&
    row.name.length <= 200;
}

function scopedChoice(
  value: unknown,
  ownerPhone: string,
  conversationId: string,
): OwnerPatientChoice | null {
  if (!value || typeof value !== "object") return null;
  const choice = value as OwnerPatientChoice;
  if (
    choice.ownerPhone !== ownerPhone ||
    choice.conversationId !== conversationId ||
    typeof choice.createdAt !== "string" ||
    typeof choice.expiresAt !== "string" ||
    typeof choice.query !== "string" || choice.query.length > 60 ||
    !Array.isArray(choice.candidates) || !choice.candidates.length ||
    choice.candidates.length > 5 || !choice.candidates.every(candidate) ||
    new Set(choice.candidates.map((item) => item.id)).size !==
      choice.candidates.length
  ) return null;
  return choice;
}

function choicePrompt(
  choice: OwnerPatientChoice,
  approximate: boolean,
): string {
  if (choice.candidates.length === 1) {
    return `¿Quisiste decir ${
      plainName(choice.candidates[0].name)
    }? Respondé "sí" para ver sus datos o "no" para buscar otro nombre.`;
  }
  return [
    approximate
      ? `No encontré una coincidencia exacta con "${
        plainName(choice.query)
      }". ¿Quisiste decir alguno de estos pacientes?`
      : `Encontré varios pacientes con "${
        plainName(choice.query)
      }". ¿A cuál te referís?`,
    "",
    ...choice.candidates.map((item, index) =>
      `${index + 1}. ${plainName(item.name)}`
    ),
    "",
    'Respondé con el número de la opción o el nombre completo. Si no es ninguno, decime "no".',
  ].join("\n");
}

async function loadDirectory(
  client: SupabaseClient,
): Promise<OwnerPatientCandidate[]> {
  const rows: OwnerPatientCandidate[] = [];
  let offset = 0;
  // Names and IDs only. Do not load every contact's phone, coverage or appointments
  // just to offer spelling suggestions. No cross-request/global patient cache.
  while (offset <= MAX_DIRECTORY_SIZE) {
    const { data, error } = await client.from("contacts")
      .select("id,name")
      .order("id")
      .range(offset, Math.min(offset + PAGE_SIZE - 1, MAX_DIRECTORY_SIZE));
    if (error) throw new Error("OWNER_PATIENT_SEARCH_UNAVAILABLE");
    if (!data?.length) return rows;
    offset += data.length;
    if (offset > MAX_DIRECTORY_SIZE) {
      throw new Error("OWNER_PATIENT_DIRECTORY_TOO_LARGE");
    }
    rows.push(...data.filter(candidate));
  }
  throw new Error("OWNER_PATIENT_DIRECTORY_TOO_LARGE");
}

async function patientDetails(
  client: SupabaseClient,
  selected: OwnerPatientCandidate,
  now: Date,
): Promise<OwnerPatientLookupReply> {
  const { data: row, error } = await client.from("contacts")
    .select("id,name,phone_e164,coverage")
    .eq("id", selected.id)
    .maybeSingle();
  if (error) throw new Error("OWNER_PATIENT_SEARCH_UNAVAILABLE");
  if (
    !row || typeof row.name !== "string" ||
    normalizePatientName(row.name) !== normalizePatientName(selected.name)
  ) {
    return {
      reply: STALE_PATIENT_REPLY,
      pending: null,
    };
  }
  const instant = now.toISOString();
  const { data: next, error: nextError } = await client.from("appointments")
    .select("starts_at,coverage,deposit_status")
    .eq("contact_id", row.id)
    .gte("starts_at", instant)
    .in("status", ["scheduled", "confirmed"])
    .or(
      `status.eq.confirmed,deposit_status.not.in.(pending,proof_received),hold_expires_at.gt.${instant}`,
    )
    .order("starts_at")
    .limit(1)
    .maybeSingle();
  if (nextError) throw new Error("OWNER_PATIENT_SEARCH_UNAVAILABLE");
  return {
    reply: formatOwnerPatient({
      matches: [{
        name: row.name,
        phone: row.phone_e164 ?? null,
        coverage: row.coverage ?? null,
        notes: null,
        nextAppointment: next
          ? {
            startsAt: next.starts_at,
            patientName: row.name,
            patientPhone: null,
            coverage: next.coverage ?? null,
            service: null,
            depositStatus: next.deposit_status ?? null,
          }
          : null,
      }],
      query: selected.name,
      timezone: OWNER_TIMEZONE,
    }),
    pending: null,
  };
}

/** Only called after verifying the signed sender against the owner allowlist.
 * A reply selects IDs offered in this same owner's conversation, never an ID
 * from the inbound text. Fuzzy results are suggestions, not patient identity. */
export async function resolveOwnerPatientLookup(args: {
  client: SupabaseClient;
  body: string;
  query?: string;
  pending?: unknown;
  ownerPhone: string;
  conversationId: string;
  now?: Date;
}): Promise<OwnerPatientLookupReply | null> {
  const now = args.now ?? new Date();
  if (args.query !== undefined) {
    const directory = await loadDirectory(args.client);
    const found = matchOwnerPatients(args.query, directory);
    if (found.kind === "none" || !found.candidates.length) {
      return {
        reply: `No encontré un paciente con "${
          plainName(args.query)
        }" ni nombres suficientemente parecidos. Probá con el nombre y apellido o consultá el sistema interno.`,
        pending: null,
      };
    }
    if (found.kind === "exact" && found.candidates.length === 1) {
      return await patientDetails(args.client, found.candidates[0], now);
    }
    const candidates = found.candidates.slice(0, 5);
    if (hasHomonym(candidates, directory)) {
      return {
        reply: AMBIGUOUS_NAME_REPLY,
        pending: null,
      };
    }
    const pending: OwnerPatientChoice = {
      ownerPhone: args.ownerPhone,
      conversationId: args.conversationId,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + CHOICE_TTL_MS).toISOString(),
      query: args.query,
      candidates,
    };
    return {
      reply: choicePrompt(pending, found.kind === "suggestions") +
        (found.candidates.length > 5
          ? "\nHay más coincidencias. Si no aparece, escribí el nombre y apellido completos."
          : ""),
      pending,
    };
  }

  const pending = scopedChoice(
    args.pending,
    args.ownerPhone,
    args.conversationId,
  );
  if (!pending) return null;
  const created = Date.parse(pending.createdAt);
  const expires = Date.parse(pending.expiresAt);
  if (
    !Number.isFinite(created) || !Number.isFinite(expires) ||
    created > now.getTime() || expires <= now.getTime() ||
    expires <= created || expires - created > CHOICE_TTL_MS
  ) {
    return {
      reply:
        'La confirmación venció. Pedime "datos de" seguido del nombre para buscar de nuevo.',
      pending: null,
    };
  }
  const answer = normalizePatientName(args.body.replace(/[¿¡!?;:]/g, ""));
  if (/^(no|no gracias|ninguno|ninguna|cancelar|cancela)$/.test(answer)) {
    return {
      reply:
        'De acuerdo. Escribime "datos de" seguido del nombre y apellido que querías consultar.',
      pending: null,
    };
  }
  const numeric = answer.match(/^(?:opcion |el |la )?([1-5])$/)?.[1];
  let selected = numeric ? pending.candidates[Number(numeric) - 1] : undefined;
  if (
    !selected && pending.candidates.length === 1 &&
    /^(si|si gracias|correcto|correcta|ese|esa|si ese|si esa)$/.test(answer)
  ) {
    selected = pending.candidates[0];
  }
  if (!selected) {
    const named = answer.replace(/^si\s+/, "");
    const matches = pending.candidates.filter((item) =>
      normalizePatientName(item.name) === named
    );
    if (matches.length === 1) selected = matches[0];
  }
  if (selected) {
    const directory = await loadDirectory(args.client);
    const current = directory.find((item) => item.id === selected.id);
    if (
      !current ||
      normalizePatientName(current.name) !== normalizePatientName(selected.name)
    ) {
      return { reply: STALE_PATIENT_REPLY, pending: null };
    }
    if (hasHomonym([current], directory)) {
      return { reply: AMBIGUOUS_NAME_REPLY, pending: null };
    }
    return await patientDetails(args.client, selected, now);
  }
  return {
    reply: `Necesito que confirmes a qué paciente te referís.\n\n${
      choicePrompt(pending, true)
    }`,
    pending,
  };
}
