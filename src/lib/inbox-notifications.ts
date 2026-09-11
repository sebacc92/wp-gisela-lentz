/**
 * Qué merece un aviso en pantalla.
 *
 * Compara dos lecturas del estado y decide si pasó algo que valga interrumpir.
 * Es pura para poder probar el caso que más importa: **abrir la aplicación con
 * mensajes viejos sin leer no es una novedad**. Si el primer render avisara,
 * sonaría cada vez que alguien entra al panel.
 */

export interface InboxSnapshot {
  /** Total de no leídos entre las conversaciones abiertas. */
  unreadCount: number;
  /** Turnos con la seña ya confirmada. */
  confirmedDeposits: number;
}

export type InboxNotificationKind = "message" | "deposit";

export interface InboxNotification {
  kind: InboxNotificationKind;
  title: string;
  /** Cuántos elementos nuevos motivaron el aviso. */
  count: number;
  href: string;
}

export function detectInboxNotifications(
  previous: InboxSnapshot | null,
  next: InboxSnapshot,
): InboxNotification[] {
  // Sin lectura anterior no hay novedad: es la primera vez que se mira.
  if (previous === null) return [];

  const notifications: InboxNotification[] = [];

  const newMessages = next.unreadCount - previous.unreadCount;
  if (newMessages > 0) {
    notifications.push({
      kind: "message",
      count: newMessages,
      title:
        newMessages === 1
          ? "Llegó un mensaje nuevo"
          : `Llegaron ${newMessages} mensajes nuevos`,
      href: "/app/inbox?filter=unread",
    });
  }

  const newDeposits = next.confirmedDeposits - previous.confirmedDeposits;
  if (newDeposits > 0) {
    notifications.push({
      kind: "deposit",
      count: newDeposits,
      title:
        newDeposits === 1
          ? "Se confirmó una seña"
          : `Se confirmaron ${newDeposits} señas`,
      href: "/app/appointments?deposit=proof_received",
    });
  }

  return notifications;
}
