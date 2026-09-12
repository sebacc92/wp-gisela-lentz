import { ORTHODONTIC_VISIT_LABELS } from "~/lib/orthodontics";
import {
  component$,
  type QRL,
  useSignal,
  useVisibleTask$,
} from "@qwik.dev/core";
import type { Conversation } from "~/lib/inbox-types";
import { coverageAndDuration, coverageLabel } from "~/lib/booking";
import {
  canSendCustomerServiceText,
  formatComplianceDate,
  getCustomerServiceWindow,
  getWhatsAppConsentStatus,
} from "~/lib/whatsapp-compliance";
import { Icon } from "../ui/Icon";
import "./inbox.css";

import { ConversationNotes } from "./ConversationNotes";

interface ContactDrawerProps {
  conversation: Conversation;
  onClose$: QRL<() => void>;
  onNewAppointment$: QRL<() => void>;
  onViewAppointment$: QRL<() => void>;
  onToggleAutomation$: QRL<() => void>;
  onTogglePending$: QRL<() => void>;
  onToggleClosed$: QRL<() => void>;
  onNotice$: QRL<(message: string) => void>;
}

function appointmentStatusClass(status: string): string {
  if (status === "Comprobante recibido") return "proof-received";
  if (status === "Esperando seña") return "scheduled";
  if (status === "Confirmado") return "confirmed";
  if (status === "Atendido") return "completed";
  if (status === "No asistió") return "no_show";
  return "cancelled";
}

export const ContactDrawer = component$<ContactDrawerProps>((props) => {
  const drawerRef = useSignal<HTMLElement>();
  const appointment = props.conversation.upcomingAppointment;
  const consentStatus = getWhatsAppConsentStatus(props.conversation);
  const serviceWindow = getCustomerServiceWindow(
    props.conversation.lastInboundMessageAt,
  );
  const canSendText = canSendCustomerServiceText(props.conversation);
  const consentLabel =
    consentStatus === "opted_in"
      ? "Consentimiento vigente"
      : consentStatus === "opted_out"
        ? "Baja vigente"
        : "Sin consentimiento registrado";
  const consentDetail =
    consentStatus === "opted_in"
      ? props.conversation.whatsappOptInAt
        ? `Registrado el ${formatComplianceDate(props.conversation.whatsappOptInAt)}.`
        : "Consentimiento vigente; fecha de registro no disponible."
      : consentStatus === "opted_out"
        ? props.conversation.whatsappOptOutAt
          ? `Baja registrada el ${formatComplianceDate(props.conversation.whatsappOptOutAt)}.`
          : "Baja vigente; fecha de registro no disponible."
        : "No se debe iniciar una conversación ni programar recordatorios para este contacto.";

  // Move keyboard focus into the newly opened surface, then return it to the
  // control that opened the drawer when the surface closes.
  // eslint-disable-next-line qwik/no-use-visible-task
  useVisibleTask$(({ cleanup }) => {
    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : undefined;
    drawerRef.value?.focus();
    cleanup(() => {
      if (previousFocus && document.contains(previousFocus)) {
        previousFocus.focus();
      }
    });
  });

  return (
    <div
      class="drawer-layer inbox-drawer-layer"
      role="presentation"
      onClick$={props.onClose$}
    >
      <aside
        ref={drawerRef}
        class="drawer contact-drawer inbox-contact-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="contact-drawer-title"
        aria-describedby="contact-drawer-description"
        tabIndex={-1}
        stoppropagation:click
        onKeyDown$={(event, element) => {
          if (event.key === "Escape") {
            props.onClose$();
            return;
          }
          if (event.key !== "Tab") return;

          const focusableElements = Array.from(
            element.querySelectorAll<HTMLElement>(
              'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
            ),
          ).filter((item) => item.offsetParent !== null);
          const first = focusableElements[0];
          const last = focusableElements.at(-1);
          if (!first || !last) return;

          if (
            event.shiftKey &&
            (document.activeElement === first ||
              document.activeElement === element)
          ) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <p id="contact-drawer-description" class="sr-only">
          Ficha rápida, turnos y acciones de {props.conversation.name}. Presioná
          Escape para cerrar.
        </p>
        <header class="drawer-header">
          <div>
            <span class="eyebrow">Ficha rápida</span>
            <h2 id="contact-drawer-title">Datos del contacto</h2>
          </div>
          <button
            class="icon-button"
            type="button"
            aria-label="Cerrar ficha del paciente"
            title="Cerrar"
            onClick$={props.onClose$}
          >
            <Icon name="x" size={20} />
          </button>
        </header>

        <div class="drawer-content">
          <section class="contact-overview">
            <span
              class={`contact-avatar large avatar-${props.conversation.avatarTone}`}
              aria-hidden="true"
            >
              {props.conversation.initials}
            </span>
            <div>
              <h3>{props.conversation.name}</h3>
              <p>{props.conversation.phone}</p>
              <small>
                {coverageLabel(props.conversation.coverage)} ·{" "}
                {props.conversation.isExistingPatient === undefined
                  ? "Paciente sin clasificar"
                  : props.conversation.isExistingPatient
                    ? "Ya era paciente"
                    : "Paciente nuevo"}
              </small>
            </div>
          </section>

          <section class="drawer-section consent-section">
            <div class="section-heading">
              <div>
                <span class="section-icon">
                  <Icon
                    name={
                      consentStatus === "opted_in" ? "check-circle" : "alert"
                    }
                    size={17}
                  />
                </span>
                <h3>Permisos de WhatsApp</h3>
              </div>
            </div>
            <div class={`consent-card consent-${consentStatus}`}>
              <strong>{consentLabel}</strong>
              <p>{consentDetail}</p>
            </div>
            <dl class="consent-details">
              <div>
                <dt>Texto libre</dt>
                <dd>
                  {canSendText
                    ? `Disponible hasta ${formatComplianceDate(serviceWindow.closesAt)}`
                    : consentStatus === "opted_out"
                      ? "Bloqueado por baja"
                      : "Ventana de 24 h cerrada"}
                </dd>
              </div>
              <div>
                <dt>Mensajes proactivos</dt>
                <dd>
                  {consentStatus === "opted_in"
                    ? "Requieren plantilla aprobada en Meta"
                    : "Bloqueados"}
                </dd>
              </div>
            </dl>
            <p class="consent-readonly-note">
              Estado de solo lectura. Toda alta o baja debe quedar respaldada
              por un registro auditable.
            </p>
          </section>

          <section class="drawer-section">
            <div class="section-heading">
              <div>
                <span class="section-icon">
                  <Icon name="calendar" size={17} />
                </span>
                <h3>Próximo turno</h3>
              </div>
              <button
                class="text-button"
                type="button"
                title="Crear un nuevo turno"
                onClick$={props.onNewAppointment$}
              >
                <Icon name="plus" size={15} /> Nuevo turno
              </button>
            </div>

            {appointment ? (
              <div class="appointment-card">
                <div class="appointment-date-block">
                  <strong>{appointment.dateLabel}</strong>
                  <span>
                    <Icon name="clock" size={15} /> {appointment.time} hs
                  </span>
                </div>
                {appointment.patientName && (
                  <p class="appointment-proof-notice">
                    Turno de {appointment.patientName}
                  </p>
                )}
                <div class="appointment-doctor">
                  <span>
                    {appointment.service ?? "Consulta"} ·{" "}
                    {coverageAndDuration(
                      appointment.coverage,
                      appointment.durationMinutes,
                    )}
                  </span>
                </div>
                {appointment.orthodonticVisitType && (
                  <p class="appointment-proof-notice">
                    Ortodoncia ·{" "}
                    {ORTHODONTIC_VISIT_LABELS[appointment.orthodonticVisitType]}
                  </p>
                )}
                {appointment.depositStatus === "not_required" && (
                  <p class="appointment-proof-notice">
                    Seña no requerida
                    {appointment.orthodonticVisitType === "in_treatment"
                      ? " · en tratamiento con Gisela"
                      : ""}
                    .
                  </p>
                )}
                {appointment.depositStatus === "proof_received" && (
                  <p class="appointment-proof-notice">
                    Comprobante recibido: falta que Gisela confirme la seña.
                  </p>
                )}
                {appointment.depositConfirmationActor ===
                  "automatic_system" && (
                  <p class="appointment-proof-notice">
                    Seña confirmada automáticamente. El comprobante queda
                    disponible para revisión.
                  </p>
                )}
                <div class="appointment-card-footer">
                  <span
                    class={`status-badge status-${appointmentStatusClass(appointment.status)}`}
                    role="status"
                  >
                    {appointment.status}
                  </span>
                  <button
                    type="button"
                    title="Abrir el detalle de este turno"
                    onClick$={props.onViewAppointment$}
                  >
                    Ver turno
                  </button>
                </div>
              </div>
            ) : (
              <div class="empty-appointment">
                <span class="empty-appointment-icon">
                  <Icon name="calendar" size={20} />
                </span>
                <p>No tiene próximos turnos.</p>
                <button
                  class="secondary-button small"
                  type="button"
                  onClick$={props.onNewAppointment$}
                >
                  <Icon name="plus" size={16} /> Crear turno
                </button>
              </div>
            )}
          </section>

          <section class="drawer-section">
            <div class="section-heading">
              <div>
                <span class="section-icon">
                  <Icon name="clock" size={17} />
                </span>
                <h3>Turnos anteriores</h3>
              </div>
            </div>
            {props.conversation.previousAppointments.length ? (
              <div class="previous-list">
                {props.conversation.previousAppointments.map((previous) => (
                  <div class="previous-item" key={previous.id}>
                    <div>
                      <strong>{previous.dateLabel}</strong>
                      <span>
                        {previous.time} · {previous.service ?? "Consulta"}
                      </span>
                    </div>
                    <Icon name="check-circle" size={17} />
                  </div>
                ))}
              </div>
            ) : (
              <p class="muted-copy">No hay turnos anteriores registrados.</p>
            )}
          </section>

          <section class="drawer-section contact-actions">
            <div class="section-heading">
              <div>
                <span class="section-icon">
                  <Icon name="settings" size={17} />
                </span>
                <h3>Acciones</h3>
              </div>
            </div>
            <button type="button" onClick$={props.onTogglePending$}>
              <span
                class={{
                  "action-dot": true,
                  warning: !props.conversation.needsHuman,
                }}
                aria-hidden="true"
              />
              <span>
                <strong>
                  {props.conversation.needsHuman
                    ? "Quitar de pendientes"
                    : "Marcar como pendiente"}
                </strong>
                <small>
                  {props.conversation.needsHuman
                    ? "La conversación ya fue atendida"
                    : "Dejar visible que requiere atención"}
                </small>
              </span>
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
                  ? "La baja de WhatsApp impide reactivar la automatización"
                  : undefined
              }
              onClick$={props.onToggleAutomation$}
            >
              <span
                class={{
                  "action-dot": true,
                  active: props.conversation.automationMode === "auto",
                }}
                aria-hidden="true"
              />
              <span>
                <strong>
                  {props.conversation.automationMode === "auto"
                    ? "Pausar este chat"
                    : "Quitar pausa manual"}
                </strong>
                <small>
                  {props.conversation.automationMode === "auto"
                    ? "Gisela manejará esta conversación"
                    : consentStatus === "opted_out"
                      ? "La baja impide reanudar el flujo automático"
                      : "El switch global o una prueba aún deben habilitar el bot"}
                </small>
              </span>
            </button>
            <button type="button" onClick$={props.onToggleClosed$}>
              <span class="action-dot neutral" aria-hidden="true" />
              <span>
                <strong>
                  {props.conversation.status === "open"
                    ? "Cerrar conversación"
                    : "Reabrir conversación"}
                </strong>
                <small>
                  {props.conversation.status === "open"
                    ? "Ocultarla de los pendientes activos"
                    : "Volver a mostrarla como activa"}
                </small>
              </span>
            </button>
          </section>

          {/* Mismo margen que el resto de las secciones del panel. */}
          <section class="drawer-section">
            <ConversationNotes conversationId={props.conversation.id} />
          </section>
        </div>
      </aside>
    </div>
  );
});
