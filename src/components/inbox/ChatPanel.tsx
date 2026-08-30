import {
  $,
  component$,
  type QRL,
  useSignal,
  useVisibleTask$,
} from "@qwik.dev/core";
import type { AppointmentSummary, Conversation } from "~/lib/inbox-types";
import type { QuickReply } from "~/lib/inbox-types";
import {
  canSendCustomerServiceText,
  formatComplianceDate,
  getCustomerServiceWindow,
  getWhatsAppConsentStatus,
} from "~/lib/whatsapp-compliance";
import { Icon } from "../ui/Icon";
import { MessageBubble } from "./MessageBubble";

interface ChatPanelProps {
  conversation: Conversation;
  depositAppointment?: AppointmentSummary;
  quickReplies: QuickReply[];
  onBack$: QRL<() => void>;
  onOpenContact$: QRL<() => void>;
  onToggleAutomation$: QRL<() => void>;
  onBotAnswerLast$: QRL<() => void>;
  onNewAppointment$: QRL<() => void>;
  onViewAppointment$: QRL<() => void>;
  onConfirmDeposit$: QRL<() => void>;
  onSend$: QRL<(body: string, idempotencyKey: string) => Promise<boolean>>;
  onLoadOlderMessages$: QRL<() => Promise<void>>;
  onNotice$: QRL<(message: string) => void>;
  highlightedMessageId?: string;
  confirmingDeposit?: boolean;
  loadingOlderMessages?: boolean;
}

export const ChatPanel = component$<ChatPanelProps>((props) => {
  const draft = useSignal("");
  const quickRepliesOpen = useSignal(false);
  const isSending = useSignal(false);
  const idempotencyKey = useSignal("");
  const currentTime = useSignal(Date.now());

  // The policy boundary can expire while an operator keeps the chat open.
  // eslint-disable-next-line qwik/no-use-visible-task
  useVisibleTask$(({ cleanup }) => {
    const timer = window.setInterval(() => {
      currentTime.value = Date.now();
    }, 30_000);
    cleanup(() => window.clearInterval(timer));
  });

  // eslint-disable-next-line qwik/no-use-visible-task
  useVisibleTask$(({ track }) => {
    const highlightedMessageId = track(() => props.highlightedMessageId);
    if (!highlightedMessageId) return;
    document
      .getElementById(`message-${highlightedMessageId}`)
      ?.scrollIntoView({ block: "center" });
  });

  const sendDraft = $(async () => {
    const body = draft.value.trim();
    if (!body || isSending.value) return;

    const consentStatus = getWhatsAppConsentStatus(props.conversation);
    if (!canSendCustomerServiceText(props.conversation)) {
      if (consentStatus === "opted_out") {
        props.onNotice$(
          "Envío bloqueado: la baja sigue vigente y no hubo un nuevo mensaje del contacto.",
        );
        return;
      }
      props.onNotice$(
        "La ventana de 24 horas está cerrada. No se puede enviar texto libre; se requiere consentimiento vigente y una plantilla aprobada por Meta.",
      );
      return;
    }

    idempotencyKey.value ||= crypto.randomUUID();
    isSending.value = true;
    try {
      const sent = await props.onSend$(body, idempotencyKey.value);
      if (sent) {
        draft.value = "";
        idempotencyKey.value = "";
        quickRepliesOpen.value = false;
      }
    } finally {
      isSending.value = false;
    }
  });

  const consentStatus = getWhatsAppConsentStatus(props.conversation);
  const serviceWindow = getCustomerServiceWindow(
    props.conversation.lastInboundMessageAt,
    currentTime.value,
  );
  const canSendText = canSendCustomerServiceText(
    props.conversation,
    currentTime.value,
  );
  const policyTitle =
    consentStatus === "opted_out" && canSendText
      ? "Respuesta solicitada por el contacto"
      : consentStatus === "opted_out"
        ? "Envío bloqueado por baja"
        : serviceWindow.open
          ? "Ventana de atención abierta"
          : "Ventana de 24 horas cerrada";
  const policyDetail =
    consentStatus === "opted_out" && canSendText
      ? `Podés responder hasta ${formatComplianceDate(serviceWindow.closesAt)}; la baja sigue bloqueando mensajes proactivos y automatización.`
      : consentStatus === "opted_out"
        ? "No se enviarán mensajes ni se reanudará la automatización para este contacto."
        : serviceWindow.open
          ? `Podés responder texto libre hasta ${formatComplianceDate(serviceWindow.closesAt)}.`
          : consentStatus === "opted_in"
            ? "Para iniciar contacto hace falta una plantilla que figure aprobada en Meta."
            : "Sin consentimiento vigente tampoco se puede iniciar contacto mediante plantilla.";

  return (
    <section
      class="chat-panel"
      aria-label={`Conversación con ${props.conversation.name}`}
    >
      <header class="chat-header">
        <button
          class="mobile-back"
          type="button"
          aria-label="Volver a conversaciones"
          onClick$={props.onBack$}
        >
          <Icon name="arrow-left" size={23} />
        </button>

        <span class={`contact-avatar avatar-${props.conversation.avatarTone}`}>
          {props.conversation.initials}
        </span>
        <button
          class="chat-contact"
          type="button"
          onClick$={props.onOpenContact$}
        >
          <strong>{props.conversation.name}</strong>
          <span>{props.conversation.phone}</span>
        </button>

        <div class="chat-header-actions">
          <span
            class={{
              "automation-chip": true,
              manual: props.conversation.automationMode === "manual",
            }}
          >
            <span />
            {props.conversation.automationMode === "auto"
              ? "Automatización activa"
              : "Atención manual"}
          </span>
        </div>
      </header>

      <nav
        class="chat-context-actions"
        aria-label="Acciones para este paciente"
      >
        {props.depositAppointment || props.conversation.upcomingAppointment ? (
          <button type="button" onClick$={props.onViewAppointment$}>
            <Icon name="calendar" size={17} /> Ver turno
          </button>
        ) : (
          <button type="button" onClick$={props.onNewAppointment$}>
            <Icon name="plus" size={17} /> Crear turno
          </button>
        )}
        {props.depositAppointment?.depositStatus === "proof_received" && (
          <button
            class="primary-button"
            type="button"
            disabled={props.confirmingDeposit}
            onClick$={props.onConfirmDeposit$}
          >
            <Icon name="check-circle" size={17} />
            {props.confirmingDeposit ? "Confirmando…" : "Confirmar seña"}
          </button>
        )}
        <button type="button" onClick$={props.onOpenContact$}>
          <Icon name="user" size={17} /> Ver paciente
        </button>
        <button
          type="button"
          disabled={
            consentStatus === "opted_out" &&
            props.conversation.automationMode === "manual"
          }
          title={
            consentStatus === "opted_out" &&
            props.conversation.automationMode === "manual"
              ? "La baja de WhatsApp impide reactivar el bot"
              : undefined
          }
          onClick$={props.onToggleAutomation$}
        >
          <Icon name="bot" size={17} />
          {props.conversation.automationMode === "auto"
            ? "Pausar bot"
            : "Reactivar bot"}
        </button>
        {props.conversation.automationMode === "manual" &&
          consentStatus !== "opted_out" && (
            <button type="button" onClick$={props.onBotAnswerLast$}>
              <Icon name="send" size={17} /> Que responda el bot
            </button>
          )}
      </nav>

      {props.conversation.needsHuman && (
        <div
          class={{
            "human-notice": true,
            priority: props.conversation.priority,
          }}
        >
          <span class="human-notice-icon">
            <Icon name="user" size={17} />
          </span>
          <p>
            <strong>
              {props.conversation.currentFlow === "late_deposit_proof"
                ? "El comprobante llegó después de vencer la reserva."
                : props.conversation.priority
                  ? "Esta conversación es prioritaria."
                  : "Esta conversación necesita atención."}
            </strong>
            {props.conversation.currentFlow === "late_deposit_proof"
              ? " El horario pudo haberse ocupado: revisalo y buscá otro turno si hace falta. No se confirmó automáticamente."
              : " La automatización está pausada mientras responde Gisela."}
          </p>
        </div>
      )}

      <div class="messages-scroll">
        <div class="messages-inner">
          {props.conversation.hasOlderMessages && (
            <div class="messages-history-control">
              <button
                class="secondary-button small"
                type="button"
                disabled={props.loadingOlderMessages}
                onClick$={props.onLoadOlderMessages$}
              >
                {props.loadingOlderMessages
                  ? "Cargando mensajes…"
                  : "Cargar mensajes anteriores"}
              </button>
            </div>
          )}
          <div class="date-divider">
            <span>Hoy</span>
          </div>
          {props.conversation.messages.map((message) => (
            <MessageBubble
              key={message.id}
              message={message}
              highlighted={message.id === props.highlightedMessageId}
            />
          ))}
        </div>
      </div>

      <footer class="composer-wrap">
        <div
          class={{
            "composer-policy": true,
            allowed: canSendText,
            blocked: !canSendText,
          }}
          role={canSendText ? "status" : "alert"}
        >
          <Icon name={canSendText ? "check-circle" : "alert"} size={16} />
          <span>
            <strong>{policyTitle}</strong>
            <small>{policyDetail}</small>
          </span>
        </div>

        {quickRepliesOpen.value && canSendText && (
          <div class="quick-replies-popover">
            <div class="popover-title">
              <strong>Respuestas rápidas</strong>
              <span>Elegí una para insertarla</span>
            </div>
            {props.quickReplies.map((reply) => (
              <button
                key={reply.shortcut}
                type="button"
                onClick$={() => {
                  draft.value = reply.body;
                  idempotencyKey.value = "";
                  quickRepliesOpen.value = false;
                }}
              >
                <span>{reply.shortcut}</span>
                <strong>{reply.title}</strong>
                <small>{reply.body}</small>
              </button>
            ))}
          </div>
        )}

        <div class="composer-actions">
          <button
            class={{ "composer-tool": true, active: quickRepliesOpen.value }}
            type="button"
            title="Respuestas rápidas"
            disabled={!canSendText || isSending.value}
            onClick$={() => (quickRepliesOpen.value = !quickRepliesOpen.value)}
          >
            <Icon name="spark" size={17} />
            <span>Respuesta rápida</span>
          </button>
          <button
            class="composer-tool"
            type="button"
            title="Revisar disponibilidad de plantillas"
            disabled={isSending.value}
            onClick$={() => {
              if (consentStatus === "opted_out") {
                props.onNotice$(
                  "No se puede usar una plantilla: el contacto solicitó la baja.",
                );
              } else if (!serviceWindow.open && consentStatus !== "opted_in") {
                props.onNotice$(
                  "No se puede iniciar contacto sin consentimiento vigente.",
                );
              } else {
                props.onNotice$(
                  "No se envió nada. Revisá en Plantillas que el estado de Meta sea APPROVED; el envío desde este botón todavía no está habilitado.",
                );
              }
            }}
          >
            <Icon name="file" size={16} />
            <span>Plantilla</span>
          </button>
        </div>

        <div class={{ composer: true, blocked: !canSendText }}>
          <button
            class="icon-button composer-emoji"
            type="button"
            aria-label="Agregar emoji"
            disabled={!canSendText || isSending.value}
          >
            <Icon name="smile" size={21} />
          </button>
          <textarea
            aria-label="Escribir un mensaje"
            rows={1}
            value={draft.value}
            disabled={!canSendText || isSending.value}
            placeholder={
              canSendText
                ? "Escribir un mensaje..."
                : "Envío de texto libre bloqueado"
            }
            onInput$={(_, element) => {
              if (element.value !== draft.value) idempotencyKey.value = "";
              draft.value = element.value;
            }}
            onKeyDown$={async (event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                await sendDraft();
              }
            }}
          />
          <button
            class="icon-button"
            type="button"
            aria-label="Adjuntar archivo"
            title="Adjuntar archivo"
            disabled={!canSendText || isSending.value}
            onClick$={() =>
              props.onNotice$(
                "Los adjuntos estarán disponibles al conectar WhatsApp.",
              )
            }
          >
            <Icon name="paperclip" size={20} />
          </button>
          <button
            class="send-button"
            type="button"
            disabled={!draft.value.trim() || !canSendText || isSending.value}
            onClick$={sendDraft}
          >
            <span>{isSending.value ? "Enviando…" : "Enviar"}</span>
            {isSending.value ? (
              <span class="small-spinner" aria-hidden="true" />
            ) : (
              <Icon name="send" size={18} />
            )}
          </button>
        </div>
        <span class="composer-hint">
          {canSendText
            ? "Enter para enviar · Shift + Enter para una nueva línea"
            : "El bloqueo también se valida en el servidor"}
        </span>
      </footer>
    </section>
  );
});
