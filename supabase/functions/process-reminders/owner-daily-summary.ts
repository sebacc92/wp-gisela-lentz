import { loadOwnerAgenda } from "../_shared/owner-agenda.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.112.2";
import {
  ownerNumbersFromEnvironment,
  ownerSummarySchedule,
  verifiedOwnerPhone,
} from "../_shared/owner-access.ts";
import {
  isCustomerServiceWindowOpen,
  sendAndRecordMessage,
  textPayload,
  whatsAppPolicyCode,
  whatsappAutomationsEnabled,
  type WhatsAppContact,
  type WhatsAppConversation,
} from "../_shared/whatsapp.ts";

export interface OwnerSummaryResult {
  status: "sent" | "skipped" | "failed";
  reason: string | null;
}

export interface OwnerSummaryRunResult extends OwnerSummaryResult {
  /** Un resultado por teléfono autorizado, sin teléfonos: el número privado no
   * viaja en la respuesta del cron ni en los logs. */
  recipients: OwnerSummaryResult[];
}

interface OwnerSummaryLedgerRow {
  id: string;
  summary_date: string;
  recipient_phone_e164: string;
  status: string;
  body: string;
  inbound_message_id: string;
  processing_started_at: string;
  contact_id: string;
  conversation_id: string;
  attempts: number;
}

function enabledFromEnvironment(): boolean {
  return typeof Deno !== "undefined"
    ? Deno.env.get("WHATSAPP_OWNER_DAILY_SUMMARY_ENABLED") === "true"
    : (
        globalThis as typeof globalThis & {
          process?: { env?: Record<string, string | undefined> };
        }
      ).process?.env?.WHATSAPP_OWNER_DAILY_SUMMARY_ENABLED === "true";
}

/** Sólo se propagan códigos propios: el mensaje de un error de red o del
 * cliente podría arrastrar una URL o un dato de la consulta. */
function failureReason(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  return /^[A-Z][A-Z_]+$/.test(code) ? code : "OWNER_SUMMARY_FAILED";
}

function aggregate(results: OwnerSummaryResult[]): OwnerSummaryResult {
  const failed = results.find((result) => result.status === "failed");
  if (failed) return { status: failed.status, reason: failed.reason };
  const sent = results.filter((result) => result.status === "sent");
  if (!sent.length) return { status: "skipped", reason: results[0].reason };
  return sent.length === results.length
    ? { status: "sent", reason: null }
    : { status: "sent", reason: "OWNER_SUMMARY_PARTIAL" };
}

/** One deterministic, private digest per authorized phone. It never uses
 * message_templates and cannot fall back to a paid message when the service
 * window is closed. */
export async function processOwnerDailySummary(args: {
  client: SupabaseClient;
  now?: Date;
  enabled?: boolean;
  ownerNumbers?: Set<string>;
  send?: typeof sendAndRecordMessage;
}): Promise<OwnerSummaryRunResult> {
  const { client } = args;
  const schedule = ownerSummarySchedule(args.now);
  if (
    !(args.enabled ?? enabledFromEnvironment()) ||
    !whatsappAutomationsEnabled()
  ) {
    return {
      status: "skipped",
      reason: "OWNER_SUMMARY_DISABLED",
      recipients: [],
    };
  }
  if (!schedule.due)
    return {
      status: "skipped",
      reason: "OWNER_SUMMARY_NOT_DUE",
      recipients: [],
    };
  const owners = args.ownerNumbers ?? ownerNumbersFromEnvironment();
  if (!owners.size) {
    return {
      status: "skipped",
      reason: "OWNER_NUMBER_NOT_CONFIGURED",
      recipients: [],
    };
  }
  const settings = await client
    .from("app_settings")
    .select("automations_enabled")
    .eq("id", true)
    .single();
  if (settings.error) throw new Error("OWNER_SETTINGS_UNAVAILABLE");
  if (settings.data?.automations_enabled !== true) {
    return {
      status: "skipped",
      reason: "AUTOMATIONS_DISABLED",
      recipients: [],
    };
  }

  // La agenda de mañana es la misma para todos: se arma una sola vez y recién
  // cuando algún destinatario habilitado la va a recibir.
  let agenda: Promise<string> | null = null;
  const body = () =>
    (agenda ??= loadOwnerAgenda({ client, day: "tomorrow", now: args.now }));

  const results: OwnerSummaryResult[] = [];
  // Orden estable: dos crones simultáneos reclaman los destinatarios en la
  // misma secuencia, y el segundo encuentra cada fila ya tomada.
  for (const phone of [...owners].sort()) {
    results.push(
      // Una falla de un destinatario no puede dejar sin agenda a los otros.
      await summaryForRecipient({
        client,
        phone,
        owners,
        summaryDate: schedule.date,
        body,
        send: args.send,
      }).catch((error) => {
        const reason = failureReason(error);
        console.error("owner-daily-summary", reason);
        return { status: "failed" as const, reason };
      }),
    );
  }
  return { ...aggregate(results), recipients: results };
}

async function summaryForRecipient(args: {
  client: SupabaseClient;
  phone: string;
  owners: Set<string>;
  summaryDate: string;
  body: () => Promise<string>;
  send?: typeof sendAndRecordMessage;
}): Promise<OwnerSummaryResult> {
  const { client, phone, owners } = args;
  const existing = await client
    .from("whatsapp_owner_daily_summaries")
    .select("status")
    .eq("summary_date", args.summaryDate)
    .eq("recipient_phone_e164", phone)
    .maybeSingle();
  if (existing.error) throw new Error("OWNER_SUMMARY_LOOKUP_FAILED");
  if (existing.data && ["sent", "skipped"].includes(existing.data.status)) {
    return { status: "skipped", reason: "OWNER_SUMMARY_ALREADY_PROCESSED" };
  }

  const contactResult = await client
    .from("contacts")
    .select(
      "id,name,phone_e164,whatsapp_id,whatsapp_user_id,whatsapp_consent_status",
    )
    .eq("phone_e164", phone)
    .maybeSingle();
  if (contactResult.error) throw new Error("OWNER_CONTACT_UNAVAILABLE");
  const contact = contactResult.data as WhatsAppContact | null;
  let conversation: WhatsAppConversation | null = null;
  let inboundId: string | null = null;
  let skipReason: string | null = contact ? null : "OWNER_HAS_NOT_MESSAGED";
  if (contact?.whatsapp_consent_status === "opted_out")
    skipReason = "CONTACT_OPTED_OUT";

  if (contact && !skipReason) {
    const result = await client
      .from("conversations")
      .select(
        "id,contact_id,coexistence_account_id,last_inbound_message_at,automation_mode,needs_human",
      )
      .eq("contact_id", contact.id)
      .eq("status", "open")
      .order("last_inbound_message_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (result.error) throw new Error("OWNER_CONVERSATION_UNAVAILABLE");
    conversation = result.data as WhatsAppConversation | null;
    if (
      !conversation ||
      !isCustomerServiceWindowOpen(conversation.last_inbound_message_at)
    ) {
      skipReason = "CUSTOMER_SERVICE_WINDOW_CLOSED";
    } else if (conversation.automation_mode !== "auto") {
      skipReason = "AUTOMATION_PAUSED";
    } else {
      const inbound = await client
        .from("messages")
        .select("id,metadata,created_at")
        .eq("conversation_id", conversation.id)
        .eq("contact_id", contact.id)
        .eq("direction", "inbound")
        .eq("whatsapp_origin", "cloud_api")
        .contains("metadata", {
          sender_identity_source: "signed_meta_webhook",
          verified_sender_phone_e164: phone,
        })
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (inbound.error) throw new Error("OWNER_INBOUND_UNAVAILABLE");
      if (
        !inbound.data ||
        verifiedOwnerPhone(inbound.data.metadata, owners) !== phone ||
        !isCustomerServiceWindowOpen(inbound.data.created_at)
      ) {
        skipReason = "OWNER_RECIPIENT_UNVERIFIED";
      } else {
        inboundId = inbound.data.id;
      }
    }
  }

  let body: string | null = null;
  if (!skipReason) body = await args.body();

  const claim = await client.rpc("claim_whatsapp_owner_daily_summary", {
    p_recipient_phone: phone,
    p_contact_id: contact?.id ?? null,
    p_conversation_id: conversation?.id ?? null,
    p_inbound_message_id: inboundId,
    p_body: body,
    p_skip_reason: skipReason,
  });
  if (claim.error) throw new Error("OWNER_SUMMARY_CLAIM_FAILED");
  const row = (
    Array.isArray(claim.data) ? claim.data[0] : claim.data
  ) as OwnerSummaryLedgerRow | null;
  if (!row || row.status !== "processing") {
    return {
      status: "skipped",
      reason: skipReason ?? "OWNER_SUMMARY_ALREADY_CLAIMED",
    };
  }
  // A previous attempt owns its recipient, provenance and body snapshot. A
  // changed conversation must not redirect that private message on retry.
  if (
    !contact ||
    !conversation ||
    row.contact_id !== contact.id ||
    row.conversation_id !== conversation.id ||
    row.recipient_phone_e164 !== phone ||
    row.summary_date !== args.summaryDate
  ) {
    throw new Error("OWNER_SUMMARY_CONTEXT_CHANGED");
  }

  let result: OwnerSummaryResult;
  let messageId: string | null = null;
  try {
    const outbound = await (args.send ?? sendAndRecordMessage)({
      client,
      contact,
      conversation,
      payload: textPayload(row.body),
      bodyPreview: row.body,
      // La clave lleva la fila del ledger: un reintento no duplica y el
      // resumen de un destinatario no deduplica contra el del otro.
      idempotencyKey: `owner-summary:${row.summary_date}:${row.id}`,
      metadata: {
        source: "owner_daily_summary",
        inbound_message_id: row.inbound_message_id,
        owner_summary_date: row.summary_date,
        owner_summary_id: row.id,
      },
    });
    if (!["sent", "delivered", "read"].includes(outbound.status)) {
      throw new Error("OWNER_SUMMARY_DELIVERY_UNCONFIRMED");
    }
    messageId = outbound.id;
    result = { status: "sent", reason: null };
  } catch (error) {
    const policyCode = whatsAppPolicyCode(error);
    result = {
      status: policyCode ? "skipped" : "failed",
      reason: policyCode ?? "OWNER_SUMMARY_SEND_FAILED",
    };
  }
  const completed = await client
    .from("whatsapp_owner_daily_summaries")
    .update({
      status: result.status,
      reason: result.reason,
      message_id: messageId,
      processing_started_at: null,
      sent_at: result.status === "sent" ? new Date().toISOString() : null,
    })
    .eq("id", row.id)
    .eq("status", "processing")
    .eq("processing_started_at", row.processing_started_at);
  if (completed.error) throw new Error("OWNER_SUMMARY_COMPLETION_FAILED");
  return result;
}
