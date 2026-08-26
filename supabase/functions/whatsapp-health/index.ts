import {
  jsonResponse,
  optionsResponse,
  safeErrorMessage,
} from "../_shared/http.ts";
import { authorizeUser, createServiceClient } from "../_shared/supabase.ts";
import {
  isWhatsAppCredentialResolutionError,
  resolveWhatsAppAccountCredentials,
} from "../_shared/whatsapp-account-credentials.ts";
import {
  observeMetaGraphAuthenticationFailure,
  parseSafetyBoolean,
  parseWhatsAppAllowedNumbers,
  whatsappAutomationsEnabled,
} from "../_shared/whatsapp.ts";
import type { WhatsAppAccountCredentials } from "../_shared/whatsapp-account-credentials.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.112.2";

interface GraphError {
  code?: number;
}

interface GraphCollection<T> {
  data?: T[];
  paging?: { next?: string; cursors?: { after?: string } };
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
const CLIENT_SCOPE = "gisela-lentz-wp";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export async function authenticatedHealthAccountId(input: {
  client: SupabaseClient;
  adminUserId: string;
  requestedAccountId: string | null;
}): Promise<string | null> {
  const result = await input.client.rpc("whatsapp_embedded_signup_status", {
    p_admin_user_id: input.adminUserId,
    p_client_scope: CLIENT_SCOPE,
  });
  if (result.error) throw new Error("WHATSAPP_HEALTH_ACCOUNT_STATUS_FAILED");
  const account = record(record(result.data)?.account);
  const statusAccountId =
    typeof account?.accountId === "string" ? account.accountId : null;
  if (
    input.requestedAccountId !== null &&
    input.requestedAccountId !== statusAccountId
  ) {
    throw new Error("WHATSAPP_HEALTH_ACCOUNT_MISMATCH");
  }
  return input.requestedAccountId ?? statusAccountId;
}

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

export function canonicalMetaGraphNextPage(input: {
  initialUrl: string;
  providerNext: string;
  afterCursor: string;
}): string {
  const initial = new URL(input.initialUrl);
  const next = new URL(input.providerNext);
  if (
    !input.providerNext.startsWith("https://graph.facebook.com/") ||
    initial.origin !== "https://graph.facebook.com" ||
    next.origin !== initial.origin ||
    next.pathname !== initial.pathname ||
    next.username !== "" ||
    next.password !== "" ||
    next.port !== "" ||
    next.hash !== "" ||
    !input.afterCursor ||
    input.afterCursor.length > 2_048 ||
    /[\u0000-\u001f\u007f]/.test(input.afterCursor)
  ) {
    throw new Error("META_INVALID_PAGINATION_URL");
  }
  const allowedKeys = new Set([...initial.searchParams.keys(), "after"]);
  for (const key of new Set(next.searchParams.keys())) {
    if (!allowedKeys.has(key) || next.searchParams.getAll(key).length !== 1) {
      throw new Error("META_INVALID_PAGINATION_URL");
    }
  }
  for (const [key, value] of initial.searchParams) {
    if (next.searchParams.get(key) !== value) {
      throw new Error("META_INVALID_PAGINATION_URL");
    }
  }
  if (next.searchParams.get("after") !== input.afterCursor) {
    throw new Error("META_INVALID_PAGINATION_URL");
  }

  // Never follow a provider URL verbatim with a customer bearer token. Only
  // the opaque cursor crosses into a URL rebuilt from our own fixed endpoint.
  const rebuilt = new URL(initial);
  rebuilt.searchParams.set("after", input.afterCursor);
  return rebuilt.toString();
}

export async function graphCollection<T>(
  initialUrl: string,
  credentials: WhatsAppAccountCredentials,
  client: SupabaseClient,
  fetchImpl: typeof fetch = fetch,
): Promise<T[]> {
  const rows: T[] = [];
  let next: string | undefined = initialUrl;
  const seenCursors = new Set<string>();

  for (let page = 0; next && page < 20; page += 1) {
    const response = await fetchImpl(next, {
      redirect: "error",
      headers: {
        Authorization: `Bearer ${credentials.businessAccessToken}`,
      },
    });
    const credentialInvalid = await observeMetaGraphAuthenticationFailure({
      client,
      credentials,
      response,
    });
    if (credentialInvalid) {
      throw new Error("META_AUTHENTICATION_FAILED");
    }
    let result: GraphCollection<T>;
    try {
      result = (await response.json()) as GraphCollection<T>;
    } catch {
      throw new Error("META_GRAPH_RESPONSE_INVALID");
    }
    if (!response.ok || result.error) {
      throw new Error("META_GRAPH_REQUEST_FAILED");
    }
    rows.push(...(result.data ?? []));
    if (!result.paging?.next) {
      next = undefined;
      continue;
    }
    const afterCursor = result.paging.cursors?.after;
    if (typeof afterCursor !== "string" || seenCursors.has(afterCursor)) {
      throw new Error("META_INVALID_PAGINATION_URL");
    }
    seenCursors.add(afterCursor);
    next = canonicalMetaGraphNextPage({
      initialUrl,
      providerNext: result.paging.next,
      afterCursor,
    });
  }

  if (next) throw new Error("META_PAGINATION_LIMIT_EXCEEDED");
  return rows;
}

export interface WhatsAppHealthHandlerDependencies {
  client?: SupabaseClient;
  authorize?: typeof authorizeUser;
  fetchImpl?: typeof fetch;
}

export async function handleWhatsAppHealthRequest(
  request: Request,
  dependencies: WhatsAppHealthHandlerDependencies = {},
): Promise<Response> {
  if (request.method === "OPTIONS") return optionsResponse(request);
  if (request.method !== "GET" && request.method !== "POST") {
    return jsonResponse(request, { error: "METHOD_NOT_ALLOWED" }, 405);
  }

  const client = dependencies.client ?? createServiceClient();
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const safety = {
    automationsEnabled: whatsappAutomationsEnabled(),
    testMode: parseSafetyBoolean(Deno.env.get("WHATSAPP_TEST_MODE"), true),
    testAllowedNumberCount: parseWhatsAppAllowedNumbers(
      Deno.env.get("WHATSAPP_TEST_ALLOWED_NUMBERS"),
    ).size,
  };
  try {
    const authorization = await (dependencies.authorize ?? authorizeUser)(
      request,
      client,
    );
    if (authorization.profile.role !== "ADMIN") {
      return jsonResponse(request, { error: "FORBIDDEN" }, 403);
    }
    const accountId = await authenticatedHealthAccountId({
      client,
      adminUserId: authorization.user.id,
      requestedAccountId: new URL(request.url).searchParams.get("accountId"),
    });
    const credentials = await resolveWhatsAppAccountCredentials({
      client,
      purpose: "management",
      coexistenceAccountId: accountId,
    });
    const graphRoot = `https://graph.facebook.com/${credentials.apiVersion}`;
    const [phoneNumbers, metaTemplates, localTemplatesResult, settingsResult] =
      await Promise.all([
        graphCollection<MetaPhoneNumber>(
          `${graphRoot}/${credentials.wabaId}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating&limit=100`,
          credentials,
          client,
          fetchImpl,
        ),
        graphCollection<MetaTemplate>(
          `${graphRoot}/${credentials.wabaId}/message_templates?fields=id,name,language,status,category&limit=100`,
          credentials,
          client,
          fetchImpl,
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
      (candidate) => candidate.id === credentials.phoneNumberId,
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
      credentialMode: credentials.credentialMode,
      accountId: credentials.accountId,
    });
  } catch (error) {
    const message = safeErrorMessage(error);
    if (message === "UNAUTHORIZED") {
      return jsonResponse(request, { error: "UNAUTHORIZED" }, 401);
    }
    const incomplete =
      message.startsWith("CONFIGURATION_INCOMPLETE") ||
      isWhatsAppCredentialResolutionError(error);
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
}

if (import.meta.main) {
  Deno.serve((request) => handleWhatsAppHealthRequest(request));
}
