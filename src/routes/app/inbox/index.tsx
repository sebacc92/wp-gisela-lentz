import {
  component$,
  useSignal,
  useStore,
  useVisibleTask$,
} from "@qwik.dev/core";
import { useLocation, type DocumentHead } from "@qwik.dev/router";
import { AppNavigation } from "~/components/app/AppNavigation";
import { AppointmentDrawer } from "~/components/appointments/AppointmentDrawer";
import { ChatPanel } from "~/components/inbox/ChatPanel";
import { ContactDrawer } from "~/components/inbox/ContactDrawer";
import {
  ConversationList,
  type InboxFilter,
} from "~/components/inbox/ConversationList";
import { Icon } from "~/components/ui/Icon";
import { getPageTitle } from "~/config/business";
import type {
  Conversation,
  BookingDurationSettings,
  Message,
  ProfessionalOption,
  QuickReply,
  ServiceOption,
} from "~/lib/inbox-types";
import { getSupabaseClient } from "~/lib/supabase/client";
import {
  loadBookingDurationSettings,
  loadInboxData,
  loadProfessionals,
  loadServices,
} from "~/lib/supabase/data";
import { loadOlderInboxMessages } from "~/lib/supabase/inbox-messages";
import { getWhatsAppConsentStatus } from "~/lib/whatsapp-compliance";
import { confirmDepositAndNotify } from "~/lib/deposit-confirmation";
import {
  createdAppointmentFromRpc,
  requestDepositAndNotify,
} from "~/lib/deposit-request";
import {
  readWhatsAppSendFailure,
  whatsappSendFailureNotice,
} from "~/lib/whatsapp-send-error";

interface InboxState {
  conversations: Conversation[];
  quickReplies: QuickReply[];
  professionals: ProfessionalOption[];
  services: ServiceOption[];
  bookingDurations: BookingDurationSettings;
  operatorName: string;
  loading: boolean;
  error: string;
}

function inboxFilterFromUrl(value: string | null): InboxFilter {
  return value === "unread" || value === "pending" ? value : "all";
}

export default component$(() => {
  const location = useLocation();
  const state = useStore<InboxState>({
    conversations: [],
    quickReplies: [],
    professionals: [],
    services: [],
    bookingDurations: { iomaMinutes: 0, privateMinutes: 0 },
    operatorName: "Gisela",
    loading: true,
    error: "",
  });
  const selectedId = useSignal("");
  const query = useSignal("");
  const filter = useSignal<InboxFilter>(
    inboxFilterFromUrl(location.url.searchParams.get("filter")),
  );
  const mobileChatOpen = useSignal(false);
  const contactDrawerOpen = useSignal(false);
  const appointmentDrawerOpen = useSignal(false);
  const notice = useSignal("");
  const confirmingDeposit = useSignal(false);
  const loadingOlderConversationId = useSignal("");
  const reloadVersion = useSignal(0);

  useVisibleTask$(async ({ track }) => {
    track(() => reloadVersion.value);
    state.error = "";
    try {
      const client = getSupabaseClient();
      const [
        { conversations, quickReplies },
        professionals,
        services,
        userResult,
        bookingDurations,
      ] = await Promise.all([
        loadInboxData(client),
        loadProfessionals(client),
        loadServices(client),
        client.auth.getUser(),
        loadBookingDurationSettings(client),
      ]);

      state.conversations = conversations;
      state.quickReplies = quickReplies;
      state.professionals = professionals;
      state.services = services;
      state.bookingDurations = bookingDurations;

      const user = userResult.data.user;
      if (user) {
        const { data: profile } = await client
          .from("profiles")
          .select("full_name")
          .eq("id", user.id)
          .single();
        if (profile?.full_name) state.operatorName = profile.full_name;
      }

      const requestedConversation =
        location.url.searchParams.get("conversation") ?? "";
      const requestedPatient = location.url.searchParams.get("patient") ?? "";
      const requestedMessage = location.url.searchParams.get("message") ?? "";
      if (
        requestedMessage &&
        conversations.some((conversation) =>
          conversation.messages.some(
            (message) => message.id === requestedMessage,
          ),
        )
      ) {
        selectedId.value =
          conversations.find((conversation) =>
            conversation.messages.some(
              (message) => message.id === requestedMessage,
            ),
          )?.id ?? "";
      } else if (
        requestedConversation &&
        conversations.some(
          (conversation) => conversation.id === requestedConversation,
        )
      ) {
        selectedId.value = requestedConversation;
      } else if (
        requestedPatient &&
        conversations.some(
          (conversation) => conversation.contactId === requestedPatient,
        )
      ) {
        selectedId.value =
          conversations.find(
            (conversation) => conversation.contactId === requestedPatient,
          )?.id ?? "";
      } else if (
        !selectedId.value ||
        !conversations.some(
          (conversation) => conversation.id === selectedId.value,
        )
      ) {
        selectedId.value = conversations[0]?.id ?? "";
      }
    } catch {
      state.error = "Revisá la conexión e intentá nuevamente.";
    } finally {
      state.loading = false;
    }
  });

  useVisibleTask$(({ cleanup }) => {
    const client = getSupabaseClient();
    const refresh = () => {
      reloadVersion.value += 1;
    };
    const channel = client
      .channel("inbox-realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "messages" },
        refresh,
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "conversations" },
        refresh,
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "appointments" },
        refresh,
      )
      .subscribe();

    cleanup(() => {
      void client.removeChannel(channel);
    });
  });

  const selectedConversation = state.conversations.find(
    (conversation) => conversation.id === selectedId.value,
  );
  const highlightedMessageId = location.url.searchParams.get("message") ?? "";
  const selectedConversationAppointments = selectedConversation
    ? [
        ...(selectedConversation.upcomingAppointment
          ? [selectedConversation.upcomingAppointment]
          : []),
        ...selectedConversation.previousAppointments,
      ]
    : [];
  const selectedDepositAppointment =
    selectedConversationAppointments.find(
      (appointment) =>
        appointment.depositStatus === "proof_received" &&
        Boolean(highlightedMessageId) &&
        appointment.depositProofMessageId === highlightedMessageId,
    ) ??
    selectedConversationAppointments.find(
      (appointment) => appointment.depositStatus === "proof_received",
    );

  const normalizedQuery = query.value.trim().toLocaleLowerCase("es-AR");
  const filteredConversations = state.conversations.filter((conversation) => {
    const matchesSearch =
      !normalizedQuery ||
      conversation.name.toLocaleLowerCase("es-AR").includes(normalizedQuery) ||
      conversation.phone
        .replace(/\s|-/g, "")
        .includes(normalizedQuery.replace(/\s|-/g, ""));
    const matchesFilter =
      filter.value === "all" ||
      (filter.value === "unread" && conversation.unreadCount > 0) ||
      (filter.value === "pending" && conversation.needsHuman);
    return matchesSearch && matchesFilter;
  });

  return (
    <main
      class={{ "app-shell": true, "mobile-chat-open": mobileChatOpen.value }}
    >
      <AppNavigation active="inbox" />

      <ConversationList
        conversations={filteredConversations}
        selectedId={selectedId.value}
        query={query.value}
        filter={filter.value}
        operatorName={state.operatorName.split(" ")[0]}
        onQueryChange$={(value) => (query.value = value)}
        onFilterChange$={(value) => (filter.value = value)}
        onSelect$={async (id) => {
          selectedId.value = id;
          mobileChatOpen.value = true;
          const conversation = state.conversations.find(
            (item) => item.id === id,
          );
          if (conversation) conversation.unreadCount = 0;
          const { error } = await getSupabaseClient().rpc(
            "mark_conversation_read",
            { p_conversation_id: id },
          );
          if (error)
            notice.value = "No pudimos marcar la conversación como leída.";
        }}
      />

      {state.loading ? (
        <section class="inbox-data-state" aria-live="polite">
          <span class="small-spinner" aria-hidden="true" />
          <p>Cargando conversaciones…</p>
        </section>
      ) : state.error ? (
        <section class="inbox-data-state error" role="alert">
          <Icon name="info" size={25} />
          <strong>No pudimos cargar la bandeja</strong>
          <p>{state.error}</p>
          <button type="button" onClick$={() => (reloadVersion.value += 1)}>
            Reintentar
          </button>
        </section>
      ) : selectedConversation ? (
        <ChatPanel
          conversation={selectedConversation}
          depositAppointment={selectedDepositAppointment}
          quickReplies={state.quickReplies}
          onBack$={() => (mobileChatOpen.value = false)}
          onOpenContact$={() => (contactDrawerOpen.value = true)}
          onNewAppointment$={() => (appointmentDrawerOpen.value = true)}
          onViewAppointment$={() => {
            const appointment =
              selectedDepositAppointment ??
              selectedConversation.upcomingAppointment;
            if (!appointment?.startsAt) return;
            const date = new Intl.DateTimeFormat("en-CA", {
              year: "numeric",
              month: "2-digit",
              day: "2-digit",
              timeZone: "America/Argentina/Buenos_Aires",
            }).format(new Date(appointment.startsAt));
            window.location.assign(
              `/app/appointments?date=${date}&appointment=${appointment.id}`,
            );
          }}
          highlightedMessageId={highlightedMessageId}
          confirmingDeposit={confirmingDeposit.value}
          loadingOlderMessages={
            loadingOlderConversationId.value === selectedConversation.id
          }
          onLoadOlderMessages$={async () => {
            if (loadingOlderConversationId.value) return;

            const oldestMessage = selectedConversation.messages.find(
              (message) =>
                Boolean(message.createdAt) &&
                typeof message.ingestSequence === "number" &&
                !message.id.startsWith("local-"),
            );
            if (
              !oldestMessage?.createdAt ||
              typeof oldestMessage.ingestSequence !== "number"
            ) {
              selectedConversation.hasOlderMessages = false;
              return;
            }

            loadingOlderConversationId.value = selectedConversation.id;
            try {
              const page = await loadOlderInboxMessages(
                getSupabaseClient(),
                selectedConversation.id,
                {
                  createdAt: oldestMessage.createdAt,
                  ingestSequence: oldestMessage.ingestSequence,
                },
              );
              const currentConversation = state.conversations.find(
                (conversation) => conversation.id === selectedConversation.id,
              );
              if (!currentConversation) return;

              const loadedIds = new Set(
                currentConversation.messages.map((message) => message.id),
              );
              currentConversation.messages = [
                ...page.messages.filter(
                  (message) => !loadedIds.has(message.id),
                ),
                ...currentConversation.messages,
              ];
              currentConversation.hasOlderMessages = page.hasOlderMessages;
            } catch {
              notice.value =
                "No pudimos cargar los mensajes anteriores. Intentá nuevamente.";
            } finally {
              if (
                loadingOlderConversationId.value === selectedConversation.id
              ) {
                loadingOlderConversationId.value = "";
              }
            }
          }}
          onConfirmDeposit$={async () => {
            const appointment = selectedDepositAppointment;
            if (!appointment || confirmingDeposit.value) return;
            if (
              !window.confirm(
                `¿Confirmar la seña de ${selectedConversation.name}? El turno quedará confirmado.`,
              )
            )
              return;
            confirmingDeposit.value = true;
            try {
              const result = await confirmDepositAndNotify(
                getSupabaseClient(),
                {
                  appointmentId: appointment.id,
                  contactId: selectedConversation.contactId,
                  startsAt: appointment.startsAt ?? "",
                  conversationId: selectedConversation.id,
                },
              );
              if (!result.confirmed) {
                notice.value = "No pudimos confirmar la seña.";
                return;
              }
              notice.value = result.notified
                ? "Seña confirmada y paciente avisado por WhatsApp."
                : "Seña confirmada. No pudimos enviar el aviso por WhatsApp.";
              reloadVersion.value += 1;
            } catch {
              notice.value =
                "No pudimos confirmar la seña. Revisá la conexión e intentá nuevamente.";
            } finally {
              confirmingDeposit.value = false;
            }
          }}
          onBotAnswerLast$={async () => {
            const { data, error } = await getSupabaseClient().rpc(
              "resume_whatsapp_automation_for_last_inbound",
              { p_conversation_id: selectedConversation.id },
            );
            if (error) {
              notice.value =
                "No pudimos reactivar el bot en esta conversación.";
              return;
            }
            selectedConversation.automationMode = "auto";
            selectedConversation.needsHuman = false;
            selectedConversation.priority = false;
            reloadVersion.value += 1;
            notice.value =
              data === "DISPATCHED"
                ? "El bot va a responder el último mensaje en menos de un minuto."
                : data === "ALREADY_ANSWERED"
                  ? "El bot quedó activo. El último mensaje ya tenía respuesta."
                  : data === "ALREADY_PROCESSED"
                    ? "El bot quedó activo. Ese mensaje ya lo había procesado."
                    : data === "CONTACT_OPTED_OUT"
                      ? "No se puede: el contacto solicitó la baja de WhatsApp."
                      : "El bot quedó activo en esta conversación.";
          }}
          onToggleAutomation$={async () => {
            const nextMode =
              selectedConversation.automationMode === "auto"
                ? "manual"
                : "auto";
            if (
              nextMode === "auto" &&
              getWhatsAppConsentStatus(selectedConversation) === "opted_out"
            ) {
              notice.value =
                "No se puede reanudar la automatización: el contacto solicitó la baja.";
              return;
            }
            const { error } = await getSupabaseClient()
              .from("conversations")
              .update({
                automation_mode: nextMode,
                needs_human:
                  nextMode === "auto" ? false : selectedConversation.needsHuman,
                priority:
                  nextMode === "auto" ? false : selectedConversation.priority,
              })
              .eq("id", selectedConversation.id);

            if (error) {
              notice.value = "No pudimos cambiar la automatización.";
              return;
            }
            selectedConversation.automationMode = nextMode;
            if (nextMode === "auto") {
              selectedConversation.needsHuman = false;
              selectedConversation.priority = false;
            }
            notice.value =
              nextMode === "auto"
                ? "Automatización reanudada."
                : "Automatización pausada. Ahora responde Gisela.";
          }}
          onSend$={async (body, idempotencyKey) => {
            const localId = `local-${idempotencyKey}`;
            let optimistic = selectedConversation.messages.find(
              (message) => message.id === localId,
            );
            if (optimistic) {
              optimistic.body = body;
              optimistic.status = "pending";
              optimistic.time = "Ahora";
            } else {
              optimistic = {
                id: localId,
                body,
                direction: "outbound",
                type: "text",
                time: "Ahora",
                status: "pending",
                createdAt: new Date().toISOString(),
              } satisfies Message;
              selectedConversation.messages.push(optimistic);
            }
            selectedConversation.lastMessage = body;
            selectedConversation.time = "Ahora";

            try {
              const { data, error, response } =
                await getSupabaseClient().functions.invoke("whatsapp-send", {
                  body: {
                    conversationId: selectedConversation.id,
                    body,
                    idempotencyKey,
                  },
                });

              if (error || data?.error) {
                optimistic.status = "failed";
                const failure = await readWhatsAppSendFailure(data, response);
                notice.value = whatsappSendFailureNotice(failure);
                return false;
              }

              optimistic.status = "sent";
              reloadVersion.value += 1;
              return true;
            } catch {
              optimistic.status = "failed";
              notice.value =
                "No pudimos confirmar el envío. Actualizá la conversación antes de volver a intentar.";
              return false;
            }
          }}
          onNotice$={(message) => (notice.value = message)}
        />
      ) : (
        <section class="inbox-data-state">
          <Icon name="message" size={32} />
          <strong>Bandeja de WhatsApp</strong>
          <p>No hay conversaciones todavía.</p>
        </section>
      )}

      {contactDrawerOpen.value && selectedConversation && (
        <ContactDrawer
          conversation={selectedConversation}
          onClose$={() => (contactDrawerOpen.value = false)}
          onNewAppointment$={() => {
            contactDrawerOpen.value = false;
            appointmentDrawerOpen.value = true;
          }}
          onViewAppointment$={() => {
            const appointment = selectedConversation.upcomingAppointment;
            if (!appointment?.startsAt) {
              notice.value = "No pudimos encontrar la fecha de este turno.";
              return;
            }
            const date = new Intl.DateTimeFormat("en-CA", {
              year: "numeric",
              month: "2-digit",
              day: "2-digit",
              timeZone: "America/Argentina/Buenos_Aires",
            }).format(new Date(appointment.startsAt));
            window.location.assign(
              `/app/appointments?date=${date}&appointment=${appointment.id}`,
            );
          }}
          onToggleAutomation$={async () => {
            const nextMode =
              selectedConversation.automationMode === "auto"
                ? "manual"
                : "auto";
            if (
              nextMode === "auto" &&
              getWhatsAppConsentStatus(selectedConversation) === "opted_out"
            ) {
              notice.value =
                "No se puede reanudar la automatización: el contacto solicitó la baja.";
              return;
            }
            const { error } = await getSupabaseClient()
              .from("conversations")
              .update({
                automation_mode: nextMode,
                needs_human:
                  nextMode === "auto" ? false : selectedConversation.needsHuman,
                priority:
                  nextMode === "auto" ? false : selectedConversation.priority,
              })
              .eq("id", selectedConversation.id);
            if (error) {
              notice.value = "No pudimos cambiar la automatización.";
              return;
            }
            selectedConversation.automationMode = nextMode;
            if (nextMode === "auto") {
              selectedConversation.needsHuman = false;
              selectedConversation.priority = false;
            }
          }}
          onTogglePending$={async () => {
            const nextNeedsHuman = !selectedConversation.needsHuman;
            const { error } = await getSupabaseClient()
              .from("conversations")
              .update({
                needs_human: nextNeedsHuman,
                priority: nextNeedsHuman
                  ? selectedConversation.priority
                  : false,
              })
              .eq("id", selectedConversation.id);
            if (error) {
              notice.value = "No pudimos actualizar el pendiente.";
              return;
            }
            selectedConversation.needsHuman = nextNeedsHuman;
            if (!nextNeedsHuman) selectedConversation.priority = false;
          }}
          onToggleClosed$={async () => {
            const nextStatus =
              selectedConversation.status === "open" ? "closed" : "open";
            const { error } = await getSupabaseClient()
              .from("conversations")
              .update({ status: nextStatus })
              .eq("id", selectedConversation.id);
            if (error) {
              notice.value = "No pudimos actualizar la conversación.";
              return;
            }
            selectedConversation.status = nextStatus;
            notice.value =
              nextStatus === "closed"
                ? "Conversación cerrada."
                : "Conversación reabierta.";
          }}
          onNotice$={(message) => (notice.value = message)}
        />
      )}

      {appointmentDrawerOpen.value && selectedConversation && (
        <AppointmentDrawer
          conversation={selectedConversation}
          professionals={state.professionals}
          services={state.services}
          bookingDurations={state.bookingDurations}
          onClose$={() => (appointmentDrawerOpen.value = false)}
          onConfirm$={async (
            professionalId,
            professionalName,
            serviceId,
            serviceName,
            startsAt,
            internalNote,
          ) => {
            const client = getSupabaseClient();
            const { data: appointmentData, error } = await client.rpc(
              "create_service_appointment",
              {
                p_contact_id: selectedConversation.contactId,
                p_professional_id: professionalId,
                p_service_id: serviceId,
                p_starts_at: startsAt,
                p_source: "manual",
                p_internal_note: internalNote || null,
              },
            );

            if (error) {
              notice.value = error.message.includes("SLOT_UNAVAILABLE")
                ? "Ese horario acaba de ocuparse. Elegí otro disponible."
                : "No pudimos crear el turno.";
              return;
            }

            const createdAppointment =
              createdAppointmentFromRpc(appointmentData);
            const notification = createdAppointment
              ? await requestDepositAndNotify(client, {
                  appointmentId: createdAppointment.id,
                  contactId: selectedConversation.contactId,
                  conversationId:
                    selectedConversation.status === "open"
                      ? selectedConversation.id
                      : undefined,
                  depositRequired: createdAppointment.depositRequired,
                })
              : { required: true, notified: false };

            appointmentDrawerOpen.value = false;
            contactDrawerOpen.value = true;
            notice.value = notification.notified
              ? `Horario de ${serviceName} reservado y pedido de seña enviado por WhatsApp.`
              : notification.required
                ? `Horario de ${serviceName} reservado. No pudimos enviar el pedido de seña por WhatsApp.`
                : `Turno de ${serviceName} guardado y confirmado. La seña está desactivada.`;
            reloadVersion.value += 1;
          }}
        />
      )}

      {notice.value && (
        <div class="toast" role="status">
          <span>{notice.value}</span>
          <button
            type="button"
            aria-label="Cerrar aviso"
            onClick$={() => (notice.value = "")}
          >
            ×
          </button>
        </div>
      )}
    </main>
  );
});

export const head: DocumentHead = {
  title: getPageTitle("Conversaciones"),
  meta: [
    {
      name: "description",
      content: "Conversaciones de WhatsApp y atención a pacientes.",
    },
  ],
};
