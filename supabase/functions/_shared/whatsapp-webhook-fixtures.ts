import type { MetaValue, MetaWebhook } from "./whatsapp-webhook.ts";

// Payload shapes follow Meta's current webhook reference (accessed
// 2026-08-26). Values are synthetic and contain no production identifiers.
export const TEST_WABA_ID = "123456789012345";
export const TEST_PHONE_NUMBER_ID = "987654321098765";
export const TEST_DISPLAY_PHONE = "15550001111";
export const TEST_CONTACT_PHONE = "15550002222";
export const TEST_CONTACT_USER_ID = "user.syntheticcontact2222";

export function webhookFixture(
  field: string,
  value: MetaValue,
  wabaId = TEST_WABA_ID,
): MetaWebhook {
  return {
    object: "whatsapp_business_account",
    entry: [{ id: wabaId, changes: [{ field, value }] }],
  };
}

export function baseValue(additions: Partial<MetaValue> = {}): MetaValue {
  return {
    messaging_product: "whatsapp",
    metadata: {
      display_phone_number: TEST_DISPLAY_PHONE,
      phone_number_id: TEST_PHONE_NUMBER_ID,
    },
    ...additions,
  };
}

export const messagesFixture = webhookFixture(
  "messages",
  baseValue({
    contacts: [
      {
        profile: {
          name: "Paciente Ejemplo",
          username: "paciente_ejemplo",
          country_code: "US",
        },
        wa_id: "",
        user_id: TEST_CONTACT_USER_ID,
      },
    ],
    messages: [
      {
        from: "",
        from_user_id: TEST_CONTACT_USER_ID,
        id: "wamid.live.text.1",
        timestamp: "1770000001",
        type: "text",
        text: { body: "Hola" },
      },
    ],
  }),
);

export const historyFixture = webhookFixture(
  "history",
  baseValue({
    // Deliberately out of order: Meta does not guarantee chunk order.
    history: [
      {
        metadata: { phase: 1, chunk_order: 2, progress: 50 },
        threads: [
          {
            id: "",
            context: {
              wa_id: "",
              user_id: TEST_CONTACT_USER_ID,
              username: "paciente_ejemplo",
              country_code: "US",
            },
            messages: [
              {
                from: "",
                from_user_id: TEST_CONTACT_USER_ID,
                id: "wamid.history.inbound.2",
                timestamp: "1760000200",
                type: "text",
                text: { body: "Mensaje histórico entrante" },
                history_context: { status: "READ" },
              },
              {
                from: "",
                to: "",
                to_user_id: TEST_CONTACT_USER_ID,
                id: "wamid.history.placeholder.2",
                timestamp: "1760000210",
                type: "media_placeholder",
                history_context: { status: "SENT" },
              },
            ],
          },
        ],
      },
      {
        metadata: { phase: 1, chunk_order: 1, progress: 25 },
        threads: [
          {
            id: TEST_CONTACT_PHONE,
            context: {
              wa_id: TEST_CONTACT_PHONE,
              user_id: TEST_CONTACT_USER_ID,
              username: "paciente_ejemplo",
              country_code: "US",
            },
            messages: [
              {
                from: TEST_DISPLAY_PHONE,
                from_user_id: TEST_CONTACT_USER_ID,
                id: "wamid.history.outbound.1",
                timestamp: 1760000100,
                type: "text",
                text: { body: "Mensaje histórico saliente" },
                history_context: { status: "DELIVERED" },
              },
            ],
          },
        ],
      },
    ],
  }),
);

export const historyMediaFollowUpFixture = webhookFixture(
  "history",
  baseValue({
    messages: [
      {
        // Meta's reference currently contradicts the placeholder's `from`;
        // ingestion must use only the wamid to enrich an existing row.
        from: "",
        from_user_id: TEST_CONTACT_USER_ID,
        id: "wamid.history.placeholder.2",
        timestamp: "1760000211",
        type: "image",
        image: {
          id: "media.synthetic.1",
          caption: "Imagen histórica",
          mime_type: "image/jpeg",
        },
      },
    ],
  }),
);

export const historyOutboundMediaFollowUpFixture = webhookFixture(
  "history",
  baseValue({
    message_echoes: [
      {
        from: "",
        to: "",
        to_user_id: TEST_CONTACT_USER_ID,
        id: "wamid.history.outbound-media.1",
        timestamp: "1760000212",
        type: "document",
        document: {
          id: "media.synthetic.outbound.1",
          filename: "indicaciones.pdf",
          mime_type: "application/pdf",
        },
      },
    ],
  }),
);

export const historyDeclinedFixture = webhookFixture(
  "history",
  baseValue({
    history: [
      {
        errors: [
          {
            code: 2593109,
            title: "History sync is turned off by the business",
            message: "History sharing is turned off",
            error_data: { details: "Synthetic fixture" },
          },
          {
            code: 131009,
            title: "Second synthetic history error",
            message: "Synthetic second error",
            error_data: { details: "Second synthetic fixture" },
          },
        ],
      },
    ],
  }),
);

export const stateSyncFixture = webhookFixture(
  "smb_app_state_sync",
  baseValue({
    state_sync: [
      {
        type: "contact",
        contact: {
          full_name: "Paciente Sincronizado",
          first_name: "Paciente",
          phone_number: "",
          user_id: TEST_CONTACT_USER_ID,
          username: "paciente_ejemplo",
          country_code: "US",
        },
        action: "add",
        metadata: { timestamp: "1760000400" },
      },
      {
        type: "contact",
        contact: {
          phone_number: "",
          user_id: TEST_CONTACT_USER_ID,
          username: "paciente_ejemplo",
          country_code: "US",
        },
        action: "remove",
        metadata: { timestamp: "1760000300" },
      },
    ],
  }),
);

export const messageEchoesFixture = webhookFixture(
  "smb_message_echoes",
  baseValue({
    contacts: [
      {
        profile: {
          username: "paciente_ejemplo",
          country_code: "US",
        },
        wa_id: "",
        user_id: TEST_CONTACT_USER_ID,
      },
    ],
    message_echoes: [
      {
        from: "",
        to: "",
        to_user_id: TEST_CONTACT_USER_ID,
        id: "wamid.echo.text.1",
        timestamp: "1760000500",
        type: "text",
        text: { body: "Respuesta manual" },
      },
      {
        from: "",
        to: "",
        to_user_id: TEST_CONTACT_USER_ID,
        id: "wamid.echo.edit.1",
        timestamp: 1760000501,
        type: "edit",
        edit: {
          original_message_id: "wamid.echo.text.1",
          message: { type: "text", text: { body: "Respuesta corregida" } },
        },
      },
      {
        from: "",
        to: "",
        to_user_id: TEST_CONTACT_USER_ID,
        id: "wamid.echo.revoke.1",
        timestamp: "1760000502",
        type: "revoke",
        revoke: { original_message_id: "wamid.echo.text.1" },
      },
    ],
  }),
);

export const liveMutationFixture = webhookFixture(
  "messages",
  baseValue({
    contacts: [
      {
        profile: { username: "paciente_ejemplo", country_code: "US" },
        wa_id: "",
        user_id: TEST_CONTACT_USER_ID,
      },
    ],
    messages: [
      {
        from: "",
        from_user_id: TEST_CONTACT_USER_ID,
        id: "wamid.live.edit.1",
        timestamp: "1760000600",
        type: "edit",
        edit: {
          original_message_id: "wamid.live.original.1",
          message: { type: "text", text: { body: "Texto editado" } },
        },
      },
      {
        from: "",
        from_user_id: TEST_CONTACT_USER_ID,
        id: "wamid.live.revoke.1",
        timestamp: "1760000601",
        type: "revoke",
        revoke: { original_message_id: "wamid.live.original.1" },
      },
    ],
  }),
);

export const unknownFieldFixture = webhookFixture(
  "future_meta_field",
  baseValue({ event: "FUTURE_EVENT" }),
);
