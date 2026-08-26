import { component$, type QRL } from "@qwik.dev/core";
import type { Conversation } from "~/lib/inbox-types";
import { coverageAndDuration, coverageLabel } from "~/lib/booking";
import {
  canSendCustomerServiceText,
  formatComplianceDate,
  getCustomerServiceWindow,
  getWhatsAppConsentStatus,
} from "~/lib/whatsapp-compliance";
import { Icon } from "../ui/Icon";

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

  return (
    <div class="drawer-layer" role="presentation" onClick$={props.onClose$}>
      <aside
        class="drawer contact-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="contact-drawer-title"
        onClick$={(event) => event.stopPropagation()}
      >
        <header class="drawer-header">
          <div>
            <span class="eyebrow">Ficha rápida</span>
            <h2 id="contact-drawer-title">Datos del contacto</h2>
          </div>
          <button
            class="icon-button"
            type="button"
            aria-label="Cerrar"
            onClick$={props.onClose$}
          >
            <Icon name="x" size={20} />
          </button>
        </header>

        <div class="drawer-content">
          <section class="contact-overview">
            <span
              class={`contact-avatar large avatar-${props.conversation.avatarTone}`}
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
                <div class="appointment-doctor">
                  <span>
                    {appointment.service ?? "Consulta"} ·{" "}
                    {coverageAndDuration(
                      appointment.coverage,
                      appointment.durationMinutes,
                    )}
                  </span>
                </div>
                {appointment.depositStatus === "proof_received" && (
                  <p class="appointment-proof-notice">
                    Comprobante recibido: falta que Gisela confirme la seña.
                  </p>
                )}
                <div class="appointment-card-footer">
                  <span
                    class={`status-badge status-${appointmentStatusClass(appointment.status)}`}
                  >
                    {appointment.status}
                  </span>
                  <button type="button" onClick$={props.onViewAppointment$}>
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
              onClick$={props.onToggleAutomation$}
            >
              <span
                class={{
                  "action-dot": true,
                  active: props.conversation.automationMode === "auto",
                }}
              />
              <span>
                <strong>
                  {props.conversation.automationMode === "auto"
                    ? "Pausar automatización"
                    : "Reanudar automatización"}
                </strong>
                <small>
                  {props.conversation.automationMode === "auto"
                    ? "Gisela manejará esta conversación"
                    : consentStatus === "opted_out"
                      ? "La baja impide reanudar el flujo automático"
                      : "El flujo automático podrá continuar"}
                </small>
              </span>
            </button>
            <button type="button" onClick$={props.onToggleClosed$}>
              <span class="action-dot neutral" />
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
        </div>
      </aside>
    </div>
  );
});
