import {
  jsonResponse,
  optionsResponse,
  safeErrorMessage,
} from "../_shared/http.ts";
import { authorizeUser, createServiceClient } from "../_shared/supabase.ts";
import {
  graphConfiguration,
  parseSafetyBoolean,
  parseWhatsAppAllowedNumbers,
  whatsappAutomationsEnabled,
} from "../_shared/whatsapp.ts";

interface GraphError {
  message?: string;
}

interface GraphCollection<T> {
  data?: T[];
  paging?: { next?: string };
  error?: GraphError;
}

interface MetaPhoneNumber {
  id?: string;
  display_phone_number?: string;
  verified_name?: string;
  quality_rating?: string;
}

interface MetaTemplate {
  id?: string;
  name?: string;
  language?: string;
  status?: string;
  category?: string;
  quality_score?: string | { score?: string };
}

const META_TEMPLATE_STATUSES = new Set([
  "PENDING",
  "APPROVED",
  "REJECTED",
  "PAUSED",
  "DISABLED",
]);

function qualityRating(value: unknown): "GREEN" | "YELLOW" | "RED" | "UNKNOWN" {
  const normalized = typeof value === "string" ? value.toUpperCase() : "";
  return normalized === "GREEN" ||
    normalized === "YELLOW" ||
    normalized === "RED"
    ? normalized
    : "UNKNOWN";
}

function templateQuality(
  template: MetaTemplate,
): "GREEN" | "YELLOW" | "RED" | "UNKNOWN" {
  const value =
    typeof template.quality_score === "string"
      ? template.quality_score
      : template.quality_score?.score;
  return qualityRating(value);
}

function safeNextPage(value: string): string {
  const next = new URL(value);
  if (next.protocol !== "https:" || next.hostname !== "graph.facebook.com") {
    throw new Error("META_INVALID_PAGINATION_URL");
  }
  return next.toString();
}

async function graphCollection<T>(
  initialUrl: string,
  accessToken: string,
): Promise<T[]> {
  const rows: T[] = [];
  let next: string | undefined = initialUrl;

  for (let page = 0; next && page < 20; page += 1) {
    const response = await fetch(next, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const result = (await response.json()) as GraphCollection<T>;
    if (!response.ok) {
      throw new Error(result.error?.message ?? `HTTP_${response.status}`);
    }
    rows.push(...(result.data ?? []));
    next = result.paging?.next ? safeNextPage(result.paging.next) : undefined;
  }

  if (next) throw new Error("META_PAGINATION_LIMIT_EXCEEDED");
  return rows;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return optionsResponse(request);
  if (request.method !== "GET" && request.method !== "POST") {
    return jsonResponse(request, { error: "METHOD_NOT_ALLOWED" }, 405);
  }

  const client = createServiceClient();
  const safety = {
    automationsEnabled: whatsappAutomationsEnabled(),
    testMode: parseSafetyBoolean(Deno.env.get("WHATSAPP_TEST_MODE"), true),
    testAllowedNumberCount: parseWhatsAppAllowedNumbers(
      Deno.env.get("WHATSAPP_TEST_ALLOWED_NUMBERS"),
    ).size,
  };
  try {
    await authorizeUser(request, client);
    const config = graphConfiguration();
    const graphRoot = `https://graph.facebook.com/${config.apiVersion}`;
    const [phoneNumbers, metaTemplates, localTemplatesResult, settingsResult] =
      await Promise.all([
        graphCollection<MetaPhoneNumber>(
          `${graphRoot}/${config.businessAccountId}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating&limit=100`,
          config.accessToken,
        ),
        graphCollection<MetaTemplate>(
          `${graphRoot}/${config.businessAccountId}/message_templates?fields=id,name,language,status,category&limit=100`,
          config.accessToken,
        ),
        client.from("message_templates").select("id,meta_name,language_code"),
        client
          .from("whatsapp_settings")
          .select("sending_paused,sending_pause_reason")
          .eq("id", true)
          .single(),
      ]);

    if (localTemplatesResult.error) throw localTemplatesResult.error;
    if (settingsResult.error || !settingsResult.data) {
      throw settingsResult.error ?? new Error("WHATSAPP_SETTINGS_NOT_FOUND");
    }

    const phone = phoneNumbers.find(
      (candidate) => candidate.id === config.phoneNumberId,
    );
    if (!phone) throw new Error("PHONE_NUMBER_NOT_IN_CONFIGURED_WABA");

    const syncedAt = new Date().toISOString();
    let approvedUtilityTemplates = 0;
    for (const local of localTemplatesResult.data ?? []) {
      const remote = metaTemplates.find(
        (candidate) =>
          candidate.name === local.meta_name &&
          candidate.language === local.language_code,
      );
      const status = remote?.status?.toUpperCase() ?? "UNVERIFIED";
      const metaStatus = META_TEMPLATE_STATUSES.has(status)
        ? status
        : "UNVERIFIED";
      const category = remote?.category?.toUpperCase() ?? null;
      const templateRating = remote ? templateQuality(remote) : null;
      const safeForUtility =
        metaStatus === "APPROVED" &&
        category === "UTILITY" &&
        templateRating !== "RED";

      if (safeForUtility) approvedUtilityTemplates += 1;
      const updates: Record<string, unknown> = {
        meta_template_id: remote?.id ?? null,
        meta_status: metaStatus,
        category,
        quality_rating: templateRating,
        last_synced_at: syncedAt,
      };
      if (!safeForUtility) updates.enabled = false;

      const { error } = await client
        .from("message_templates")
        .update(updates)
        .eq("id", local.id);
      if (error) throw error;
    }

    const rating = qualityRating(phone.quality_rating);
    const qualityBlocked = rating === "RED";
    const alreadyPaused = settingsResult.data.sending_paused as boolean;
    const paused = alreadyPaused || qualityBlocked;
    const pauseReason = qualityBlocked
      ? "META_QUALITY_RED"
      : ((settingsResult.data.sending_pause_reason as string | null) ?? null);

    const { error: settingsError } = await client
      .from("whatsapp_settings")
      .update({
        display_phone: phone.display_phone_number ?? null,
        display_name: phone.verified_name ?? null,
        integration_status: paused ? "error" : "connected",
        quality_rating: rating,
        quality_updated_at: syncedAt,
        sending_paused: paused,
        sending_pause_reason: paused ? pauseReason : null,
        last_health_check_at: syncedAt,
        last_error: paused ? pauseReason : null,
      })
      .eq("id", true);
    if (settingsError) throw settingsError;

    return jsonResponse(request, {
      status: paused ? "paused" : "connected",
      displayPhone: phone.display_phone_number ?? null,
      displayName: phone.verified_name ?? null,
      qualityRating: rating,
      sendingPaused: paused,
      sendingPauseReason: paused ? pauseReason : null,
      templates: {
        configured: (localTemplatesResult.data ?? []).length,
        approvedUtility: approvedUtilityTemplates,
      },
      safety,
    });
  } catch (error) {
    const message = safeErrorMessage(error);
    if (message === "UNAUTHORIZED") {
      return jsonResponse(request, { error: "UNAUTHORIZED" }, 401);
    }
    const incomplete = message.startsWith("CONFIGURATION_INCOMPLETE");
    const checkedAt = new Date().toISOString();
    await client
      .from("whatsapp_settings")
      .update({
        integration_status: incomplete ? "incomplete" : "error",
        quality_rating: "UNKNOWN",
        quality_updated_at: checkedAt,
        last_health_check_at: checkedAt,
        last_error: incomplete
          ? "Configuración incompleta"
          : "Falló la conexión o la validación con Meta",
      })
      .eq("id", true);

    return jsonResponse(
      request,
      {
        status: incomplete ? "incomplete" : "error",
        message: incomplete
          ? "La conexión con WhatsApp todavía no está configurada."
          : "No pudimos validar el número, la WABA y las plantillas con Meta.",
        safety,
      },
      incomplete ? 200 : 502,
    );
  }
});
