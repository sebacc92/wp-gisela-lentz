import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Notas internas de una conversación.
 *
 * Son del equipo: no viajan por WhatsApp ni las lee la automatización. Viven
 * en su propia tabla para que no exista ningún camino que las confunda con un
 * mensaje enviable (ver `conversation-notes-isolation-contract.test.ts`).
 */

export interface ConversationNote {
  id: string;
  body: string;
  authorName: string | null;
  authorId: string | null;
  createdAt: string;
}

export const CONVERSATION_NOTE_MAX_LENGTH = 2000;

function relation<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

export async function loadConversationNotes(
  client: SupabaseClient,
  conversationId: string,
): Promise<ConversationNote[]> {
  const { data, error } = await client
    .from("conversation_notes")
    .select("id,body,author_id,created_at,profiles(full_name)")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw error;

  return (data ?? []).map((raw) => {
    const row = raw as unknown as {
      id: string;
      body: string;
      author_id: string | null;
      created_at: string;
      profiles: { full_name: string } | Array<{ full_name: string }> | null;
    };
    return {
      id: row.id,
      body: row.body,
      authorId: row.author_id,
      authorName: relation(row.profiles)?.full_name ?? null,
      createdAt: row.created_at,
    };
  });
}

export async function createConversationNote(
  client: SupabaseClient,
  input: { conversationId: string; body: string },
): Promise<void> {
  const body = input.body.trim();
  if (!body) throw new Error("EMPTY_NOTE");

  const { data: userData } = await client.auth.getUser();
  const authorId = userData.user?.id;
  // La política exige que el autor sea quien escribe: sin sesión no se guarda.
  if (!authorId) throw new Error("UNAUTHORIZED");

  const { error } = await client.from("conversation_notes").insert({
    conversation_id: input.conversationId,
    author_id: authorId,
    body: body.slice(0, CONVERSATION_NOTE_MAX_LENGTH),
  });
  if (error) throw error;
}

export async function deleteConversationNote(
  client: SupabaseClient,
  noteId: string,
): Promise<void> {
  const { error } = await client
    .from("conversation_notes")
    .delete()
    .eq("id", noteId);
  if (error) throw error;
}
