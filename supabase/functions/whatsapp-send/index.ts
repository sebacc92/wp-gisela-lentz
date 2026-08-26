import {
  jsonResponse,
  optionsResponse,
  safeErrorMessage,
} from "../_shared/http.ts";
import { authorizeUser, createServiceClient } from "../_shared/supabase.ts";
import {
  isCustomerServiceWindowOpen,
  isOperatorWhatsAppPurpose,
  isWhatsAppPolicyError,
  operatorSourceForPurpose,
  sendAndRecordMessage,
  templatePayload,
  textPayload,
  type WhatsAppContact,
  type WhatsAppConversation,
  validIdempotencyKey,
} from "../_shared/whatsapp.ts";

interface SendRequest {
  conversationId?: string;
  body?: string;
  idempotencyKey?: string;
  templateKey?: string;
  templateParameters?: string[];
  appointmentId?: string;
  purpose?: unknown;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return optionsResponse(request);
  if (request.method !== "POST") {
    return jsonResponse(request, { error: "METHOD_NOT_ALLOWED" }, 405);
  }

  const client = createServiceClient();
  try {
    const { user } = await authorizeUser(request, client);
    const rawInput: unknown = await request.json();
    if (
      !rawInput ||
      typeof rawInput !== "object" ||
      Array.isArray(rawInput) ||
      Object.prototype.hasOwnProperty.call(rawInput, "source")
    ) {
      return jsonResponse(
        request,
        { error: "INVALID_REQUEST", message: "El envío no es válido." },
        400,
      );
    }
    const input = rawInput as SendRequest;
    const purpose = input.purpose ?? "operator_message";
    if (!isOperatorWhatsAppPurpose(purpose)) {
      return jsonResponse(
        request,
        { error: "INVALID_PURPOSE", message: "El tipo de envío no es válido." },
        400,
      );
    }
    const source = operatorSourceForPurpose(purpose);
    const conversationId = input.conversationId?.trim();
    const body = input.body?.trim() ?? "";
    const requestId = input.idempotencyKey?.trim() ?? "";
    const templateKey = input.templateKey?.trim() || null;
    const appointmentId = input.appointmentId?.trim() || null;
    const idempotencyKey = `operator:${user.id}:${requestId}`;

    if (!conversationId || (!body && !templateKey)) {
      return jsonResponse(
        request,
        { error: "INVALID_REQUEST", message: "Falta el mensaje a enviar." },
        400,
      );
    }
    if (
      purpose !== "operator_message" &&
      (!appointmentId || templateKey !== null)
    ) {
      return jsonResponse(
        request,
        {
          error: "APPOINTMENT_CONTEXT_REQUIRED",
          message: "El aviso de seña necesita un turno y texto relacionado.",
        },
        400,
      );
    }
    if (!requestId || !validIdempotencyKey(idempotencyKey)) {
      return jsonResponse(
        request,
        {
          error: "INVALID_IDEMPOTENCY_KEY",
          message: "Falta un identificador válido y único para este envío.",
        },
        400,
      );
    }
    if (body.length > 4096) {
      return jsonResponse(
        request,
        {
          error: "MESSAGE_TOO_LONG",
          message: "El mensaje es demasiado largo.",
        },
        400,
      );
    }
    if (
      input.templateParameters &&
      (input.templateParameters.length > 10 ||
        input.templateParameters.some(
          (parameter) =>
            typeof parameter !== "string" || parameter.length > 1024,
        ))
    ) {
      return jsonResponse(
        request,
        {
          error: "INVALID_TEMPLATE_PARAMETERS",
          message: "Los parámetros de la plantilla no son válidos.",
        },
        400,
      );
    }

    const { data: conversation, error: conversationError } = await client
      .from("conversations")
      .select(
        "id,contact_id,last_inbound_message_at,automation_mode,needs_human",
      )
      .eq("id", conversationId)
      .single();
    if (conversationError || !conversation) {
      return jsonResponse(
        request,
        {
          error: "CONVERSATION_NOT_FOUND",
          message: "La conversación no existe.",
        },
        404,
      );
    }

    const { data: contact, error: contactError } = await client
      .from("contacts")
      .select(
        "id,phone_e164,whatsapp_id,whatsapp_user_id,name,whatsapp_opt_in_at,whatsapp_opt_out_at,whatsapp_consent_status",
      )
      .eq("id", conversation.contact_id)
      .single();
    if (contactError || !contact) {
      return jsonResponse(
        request,
        { error: "CONTACT_NOT_FOUND", message: "El contacto no existe." },
        404,
      );
    }

    if (purpose !== "operator_message") {
      const { data: appointment, error: appointmentError } = await client
        .from("appointments")
        .select("id,contact_id,status,deposit_status,hold_expires_at")
        .eq("id", appointmentId)
        .eq("contact_id", contact.id)
        .maybeSingle();
      const validRequest =
        purpose === "operator_deposit_request" &&
        appointment?.status === "scheduled" &&
        appointment.deposit_status === "pending" &&
        typeof appointment.hold_expires_at === "string" &&
        new Date(appointment.hold_expires_at).getTime() > Date.now();
      const validConfirmation =
        purpose === "operator_deposit_confirmation" &&
        appointment?.status === "confirmed" &&
        (appointment.deposit_status === "confirmed" ||
          appointment.deposit_status === "not_required");
      if (
        appointmentError ||
        !appointment ||
        (!validRequest && !validConfirmation)
      ) {
        return jsonResponse(
          request,
          {
            error:
              purpose === "operator_deposit_request"
                ? "DEPOSIT_REQUEST_STALE"
                : "DEPOSIT_CONFIRMATION_STALE",
            message: "El estado del turno cambió. Actualizá antes de enviar.",
          },
          409,
        );
      }
    }

    const serviceWindowOpen = isCustomerServiceWindowOpen(
      conversation.last_inbound_message_at,
    );
    let payload: Record<string, unknown>;
    let bodyPreview = body;
    let templateName: string | null = null;

    if (templateKey) {
      if (!appointmentId) {
        return jsonResponse(
          request,
          {
            error: "APPOINTMENT_CONTEXT_REQUIRED",
            message:
              "Para usar una plantilla se necesita el turno relacionado.",
          },
          400,
        );
      }
      const { data: template, error: templateError } = await client
        .from("message_templates")
        .select(
          "key,meta_name,language_code,body_preview,enabled,category,meta_status",
        )
        .eq("key", templateKey)
        .single();
      if (
        templateError ||
        !template?.enabled ||
        (template.meta_status as string | null)?.toUpperCase() !== "APPROVED" ||
        (template.category as string | null)?.toUpperCase() !== "UTILITY"
      ) {
        return jsonResponse(
          request,
          {
            error: "TEMPLATE_UNAVAILABLE",
            message: "La plantilla de WhatsApp no está disponible.",
          },
          409,
        );
      }

      const { data: appointment, error: appointmentError } = await client
        .from("appointments")
        .select("id,contact_id")
        .eq("id", appointmentId)
        .eq("contact_id", contact.id)
        .maybeSingle();
      if (appointmentError || !appointment) {
        return jsonResponse(
          request,
          {
            error: "APPOINTMENT_CONTEXT_INVALID",
            message: "El turno no corresponde a esta conversación.",
          },
          409,
        );
      }
      templateName = template.meta_name as string;
      bodyPreview = body || (template.body_preview as string);
      payload = templatePayload(
        template.meta_name as string,
        template.language_code as string,
        input.templateParameters ?? [],
      );
    } else if (!serviceWindowOpen) {
      return jsonResponse(
        request,
        {
          error: "TEMPLATE_REQUIRED",
          message:
            "Para contactar nuevamente a este paciente se necesita una plantilla de WhatsApp.",
        },
        409,
      );
    } else {
      payload = textPayload(body);
    }

    const message = await sendAndRecordMessage({
      client,
      conversation: conversation as WhatsAppConversation,
      contact: contact as WhatsAppContact,
      payload,
      bodyPreview,
      idempotencyKey,
      sentBy: user.id,
      templateName,
      templateKey,
      appointmentId,
      metadata: {
        source,
        purpose,
        request_id: requestId,
        ...(appointmentId ? { appointment_id: appointmentId } : {}),
        ...(templateKey
          ? { template_key: templateKey, appointment_id: appointmentId }
          : {}),
      },
    });

    if (!message.deduplicated) {
      await Promise.all([
        client
          .from("conversations")
          .update({
            automation_mode: "manual",
            needs_human: false,
            automation_pause_source: "operator",
            automation_pause_message_id: null,
          })
          .eq("id", conversationId),
        client.from("audit_logs").insert({
          actor_user_id: user.id,
          action: "message.manual_sent",
          entity_type: "message",
          entity_id: message.id,
          metadata: {
            conversation_id: conversationId,
            template_name: templateName,
            template_key: templateKey,
            appointment_id: appointmentId,
            purpose,
            idempotency_key: idempotencyKey,
          },
        }),
      ]);
    }

    return jsonResponse(
      request,
      { message },
      message.status === "pending" ? 202 : 200,
    );
  } catch (error) {
    const message = safeErrorMessage(error);
    if (message === "UNAUTHORIZED") {
      return jsonResponse(request, { error: "UNAUTHORIZED" }, 401);
    }
    if (message.startsWith("CONFIGURATION_INCOMPLETE")) {
      return jsonResponse(
        request,
        {
          error: "CONFIGURATION_INCOMPLETE",
          message: "La conexión con WhatsApp todavía no está configurada.",
        },
        503,
      );
    }
    if (isWhatsAppPolicyError(error)) {
      return jsonResponse(
        request,
        {
          error: error.code,
          message:
            error.code === "CONTACT_OPTED_OUT"
              ? "El contacto pidió no recibir mensajes proactivos."
              : error.code === "CUSTOMER_SERVICE_WINDOW_CLOSED"
                ? "La ventana de atención de WhatsApp está cerrada."
                : "El envío fue bloqueado por las reglas de WhatsApp.",
        },
        409,
      );
    }
    console.error("whatsapp-send", message);
    return jsonResponse(
      request,
      { error: "SEND_FAILED", message: "No pudimos enviar el mensaje." },
      502,
    );
  }
});
