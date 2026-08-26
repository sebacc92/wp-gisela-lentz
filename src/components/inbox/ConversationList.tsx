import { component$, type QRL } from "@qwik.dev/core";
import type { Conversation } from "~/lib/inbox-types";
import { Icon } from "../ui/Icon";

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
  return (
    <section class="conversation-panel" aria-label="Conversaciones">
      <header class="conversation-panel-header">
        <div>
          <span class="eyebrow">WhatsApp</span>
          <h1>Bandeja</h1>
        </div>
        <div class="header-user" title="Usuario actual">
          <span class="online-dot" />
          <span>{props.operatorName || "Recepción"}</span>
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
            onInput$={(_, element) => props.onQueryChange$(element.value)}
          />
          {props.query && (
            <button
              type="button"
              class="search-clear"
              aria-label="Limpiar búsqueda"
              onClick$={() => props.onQueryChange$("")}
            >
              <Icon name="x" size={15} />
            </button>
          )}
        </label>

        <div class="filter-pills" aria-label="Filtrar conversaciones">
          {filters.map((item) => (
            <button
              key={item.key}
              type="button"
              class={{ "filter-pill": true, active: props.filter === item.key }}
              onClick$={() => props.onFilterChange$(item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      <div class="conversation-list">
        {props.conversations.length === 0 ? (
          <div class="list-empty">
            <Icon name="search" size={22} />
            <p>No encontramos conversaciones.</p>
            <span>Probá con otro nombre o teléfono.</span>
          </div>
        ) : (
          props.conversations.map((conversation) => (
            <button
              key={conversation.id}
              type="button"
              class={{
                "conversation-item": true,
                selected: conversation.id === props.selectedId,
              }}
              onClick$={() => props.onSelect$(conversation.id)}
            >
              <span class={`contact-avatar avatar-${conversation.avatarTone}`}>
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
