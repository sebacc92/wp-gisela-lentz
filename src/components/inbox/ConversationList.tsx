import { component$, type QRL } from "@qwik.dev/core";
import { ManualHelpLink } from "~/components/app/ManualHelpLink";
import type { Conversation } from "~/lib/inbox-types";
import { Icon } from "../ui/Icon";
import "./inbox.css";

export type InboxFilter = "all" | "unread" | "pending";

interface ConversationListProps {
  conversations: Conversation[];
  selectedId: string;
  query: string;
  filter: InboxFilter;
  operatorName?: string;
  onQueryChange$: QRL<(query: string) => void>;
  onFilterChange$: QRL<(filter: InboxFilter) => void>;
  onSelect$: QRL<(id: string) => void>;
}

const filters: Array<{ key: InboxFilter; label: string }> = [
  { key: "all", label: "Todos" },
  { key: "unread", label: "No leídos" },
  { key: "pending", label: "Pendientes" },
];

export const ConversationList = component$<ConversationListProps>((props) => {
  const hasQuery = Boolean(props.query.trim());
  const emptyTitle = hasQuery
    ? "No hay resultados para esta búsqueda"
    : props.filter === "unread"
      ? "No hay mensajes sin leer"
      : props.filter === "pending"
        ? "No hay conversaciones pendientes"
        : "No hay conversaciones todavía";
  const emptyDetail = hasQuery
    ? "Revisá el nombre o teléfono e intentá de nuevo."
    : props.filter === "all"
      ? "Las conversaciones nuevas aparecerán acá."
      : "Probá cambiando el filtro para ver más conversaciones.";

  return (
    <section
      id="app-content"
      class="conversation-panel inbox-conversation-panel"
      aria-label="Conversaciones"
      tabIndex={-1}
    >
      <header class="conversation-panel-header">
        <div>
          <span class="eyebrow">WhatsApp</span>
          <h1>Bandeja</h1>
        </div>
        <div class="conversation-header-actions">
          <ManualHelpLink section="whatsapp" label="¿Cómo funciona WhatsApp?" />
          <div class="header-user" title="Usuario actual">
            <span class="online-dot" />
            <span>{props.operatorName || "Recepción"}</span>
          </div>
        </div>
      </header>

      <div class="conversation-tools">
        <label class="search-field">
          <Icon name="search" size={18} />
          <span class="sr-only">Buscar conversación</span>
          <input
            type="search"
            value={props.query}
            placeholder="Buscar conversación"
            autoComplete="off"
            enterKeyHint="search"
            onInput$={(_, element) => props.onQueryChange$(element.value)}
          />
          {props.query && (
            <button
              type="button"
              class="search-clear"
              aria-label="Limpiar búsqueda"
              title="Limpiar búsqueda"
              onClick$={() => props.onQueryChange$("")}
            >
              <Icon name="x" size={15} />
            </button>
          )}
        </label>

        <div
          class="filter-pills"
          role="group"
          aria-label="Filtrar conversaciones"
        >
          {filters.map((item) => (
            <button
              key={item.key}
              type="button"
              class={{ "filter-pill": true, active: props.filter === item.key }}
              aria-pressed={props.filter === item.key}
              onClick$={() => props.onFilterChange$(item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      <div class="conversation-list">
        <span class="sr-only" aria-live="polite">
          {props.conversations.length === 1
            ? "1 conversación visible"
            : `${props.conversations.length} conversaciones visibles`}
        </span>
        {props.conversations.length === 0 ? (
          <div class="list-empty">
            <Icon name="search" size={22} />
            <p>{emptyTitle}</p>
            <span>{emptyDetail}</span>
          </div>
        ) : (
          props.conversations.map((conversation) => (
            <button
              key={conversation.id}
              type="button"
              class={{
                "conversation-item": true,
                selected: conversation.id === props.selectedId,
                "has-unread": conversation.unreadCount > 0,
              }}
              aria-current={
                conversation.id === props.selectedId ? "true" : undefined
              }
              onClick$={() => props.onSelect$(conversation.id)}
            >
              <span
                class={`contact-avatar avatar-${conversation.avatarTone}`}
                aria-hidden="true"
              >
                {conversation.initials}
                {conversation.needsHuman && <i aria-hidden="true" />}
              </span>
              <span class="conversation-copy">
                <span class="conversation-row">
                  <strong>{conversation.name}</strong>
                  <time>{conversation.time}</time>
                </span>
                <span class="conversation-row conversation-preview-row">
                  <span class="conversation-preview">
                    {conversation.lastMessage}
                  </span>
                  {conversation.unreadCount > 0 && (
                    <span
                      class="unread-count"
                      aria-label={`${conversation.unreadCount} sin leer`}
                    >
                      {conversation.unreadCount}
                    </span>
                  )}
                </span>
                {conversation.needsHuman && (
                  <span
                    class={{
                      "attention-label": true,
                      priority: conversation.priority,
                    }}
                  >
                    <span />
                    {conversation.priority
                      ? "Atención prioritaria"
                      : "Necesita atención"}
                  </span>
                )}
              </span>
            </button>
          ))
        )}
      </div>
    </section>
  );
});
