import type { SupabaseClient } from "@supabase/supabase-js";
import type { Message } from "../inbox-types";

export const INBOX_MESSAGE_PAGE_SIZE = 50;

export interface InboxMessageRow {
  id: string;
  conversation_id: string;
  body: string;
  direction: "inbound" | "outbound";
  type: Message["type"];
  status: Message["status"];
  created_at: string;
  whatsapp_ingest_sequence: number;
  metadata: Record<string, unknown>;
}

export interface InboxMessageCursor {
  createdAt: string;
  ingestSequence: number;
}

export interface InboxMessagePage {
  messages: Message[];
  hasOlderMessages: boolean;
}

export function formatInboxMessageTime(dateValue: string): string {
  const date = new Date(dateValue);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();

  if (sameDay) {
    return new Intl.DateTimeFormat("es-AR", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);
  }

  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "Ayer";

  return new Intl.DateTimeFormat("es-AR", {
    day: "2-digit",
    month: "2-digit",
  }).format(date);
}

function mapInboxMessage(row: InboxMessageRow): Message {
  return {
    id: row.id,
    body: row.body,
    direction: row.type === "system" ? "system" : row.direction,
    type: row.type,
    time: formatInboxMessageTime(row.created_at),
    status: row.direction === "outbound" ? row.status : undefined,
    createdAt: row.created_at,
    ingestSequence: row.whatsapp_ingest_sequence,
    filename:
      typeof row.metadata?.filename === "string"
        ? row.metadata.filename
        : undefined,
    mimeType:
      typeof row.metadata?.mime_type === "string"
        ? row.metadata.mime_type
        : undefined,
    hasMedia:
      (row.type === "image" ||
        row.type === "document" ||
        row.type === "audio") &&
      typeof row.metadata?.media_id === "string" &&
      Boolean(row.metadata.media_id),
    depositProofLate: row.metadata?.deposit_proof_late === true,
  };
}

export function inboxMessagePageFromRows(
  rows: InboxMessageRow[],
): InboxMessagePage {
  const recentRows = rows.slice(0, INBOX_MESSAGE_PAGE_SIZE);

  return {
    // Queries arrive newest-first so the UI can render the page chronologically.
    messages: [...recentRows].reverse().map(mapInboxMessage),
    hasOlderMessages: rows.length > INBOX_MESSAGE_PAGE_SIZE,
  };
}

export async function loadOlderInboxMessages(
  client: SupabaseClient,
  conversationId: string,
  before: InboxMessageCursor,
): Promise<InboxMessagePage> {
  const { data, error } = await client
    .from("messages")
    .select(
      "id,conversation_id,body,direction,type,status,created_at,whatsapp_ingest_sequence,metadata",
    )
    .eq("conversation_id", conversationId)
    // Edit/revoke rows are durable audit events. Their effect is already
    // reconciled onto the original message, so they must not become bubbles.
    .is("original_whatsapp_message_id", null)
    .or(
      `created_at.lt.${before.createdAt},and(created_at.eq.${before.createdAt},whatsapp_ingest_sequence.lt.${before.ingestSequence})`,
    )
    .order("created_at", { ascending: false })
    .order("whatsapp_ingest_sequence", { ascending: false })
    .limit(INBOX_MESSAGE_PAGE_SIZE + 1);

  if (error) throw error;

  return inboxMessagePageFromRows((data ?? []) as unknown as InboxMessageRow[]);
}
