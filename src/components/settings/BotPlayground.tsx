import {
  component$,
  useComputed$,
  useContext,
  useSignal,
} from "@qwik.dev/core";
import { Icon } from "~/components/ui/Icon";
import {
  simulateBotRouting,
  type PlaygroundMessageType,
} from "~/lib/bot-playground";
import { SETTINGS_CONTEXT } from "./SettingsContext";
import "./bot-playground.css";

const EXAMPLES: { label: string; body: string; type: PlaygroundMessageType }[] =
  [
    {
      label: "Pedir un turno",
      body: "Hola, quería sacar un turno",
      type: "text",
    },
    {
      label: "Urgencia",
      body: "Tengo dolor intenso desde anoche",
      type: "text",
    },
    { label: "Consulta clínica", body: "¿Me pasás la receta?", type: "text" },
    { label: "Comprobante", body: "", type: "image" },
    { label: "Baja", body: "No quiero recibir más mensajes", type: "text" },
  ];

const TYPE_LABELS: Record<PlaygroundMessageType, string> = {
  text: "Texto",
  interactive: "Botón",
  image: "Imagen",
  document: "Documento",
  audio: "Audio",
};

/**
 * Probador de la automatización.
 *
 * Escribís un mensaje como si lo mandara un paciente y muestra qué haría el
 * bot. **No envía nada ni toca ninguna conversación**: sólo aplica las reglas
 * de ruteo, así se puede probar un cambio de configuración sin arriesgar un
 * mensaje real a alguien.
 */
export const BotPlayground = component$(() => {
  const settings = useContext(SETTINGS_CONTEXT);
  const body = useSignal("Hola, quería sacar un turno");
  const type = useSignal<PlaygroundMessageType>("text");
  const mode = useSignal<"auto" | "manual">("auto");
  const optedOut = useSignal(false);

  const result = useComputed$(() =>
    simulateBotRouting({
      body: body.value,
      type: type.value,
      // El kill switch real es el que ya está guardado; no se toca desde acá.
      automationsEnabled: !settings.state.sendingPaused,
      automationMode: mode.value,
      optedOut: optedOut.value,
    }),
  );

  return (
    <section class="settings-block bot-playground">
      <div>
        <h2>Probar la automatización</h2>
        <p>
          Escribí un mensaje como si lo mandara un paciente y mirá qué haría el
          bot. No se envía nada ni se toca ninguna conversación.
        </p>
      </div>

      <div class="bot-playground-examples">
        {EXAMPLES.map((example) => (
          <button
            key={example.label}
            class="filter-pill"
            type="button"
            onClick$={() => {
              body.value = example.body;
              type.value = example.type;
            }}
          >
            {example.label}
          </button>
        ))}
      </div>

      <label class="form-field">
        <span>Mensaje del paciente</span>
        <textarea
          rows={3}
          value={body.value}
          placeholder="Hola, quería sacar un turno"
          onInput$={(_, element) => (body.value = element.value)}
        />
      </label>

      <div class="bot-playground-controls">
        <label class="form-field">
          <span>Tipo de mensaje</span>
          <select
            value={type.value}
            onChange$={(_, element) =>
              (type.value = element.value as PlaygroundMessageType)
            }
          >
            {(Object.keys(TYPE_LABELS) as PlaygroundMessageType[]).map(
              (value) => (
                <option key={value} value={value}>
                  {TYPE_LABELS[value]}
                </option>
              ),
            )}
          </select>
        </label>

        <label class="form-field">
          <span>Estado del chat</span>
          <select
            value={mode.value}
            onChange$={(_, element) =>
              (mode.value = element.value as "auto" | "manual")
            }
          >
            <option value="auto">Automático</option>
            <option value="manual">En pausa manual</option>
          </select>
        </label>

        <label class="settings-checkbox">
          <input
            type="checkbox"
            checked={optedOut.value}
            onChange$={(_, element) => (optedOut.value = element.checked)}
          />
          <span>El contacto pidió no recibir mensajes</span>
        </label>
      </div>

      <div
        class={`bot-playground-result route-${result.value.route}`}
        role="status"
        aria-live="polite"
      >
        <span class="bot-playground-result-icon" aria-hidden="true">
          <Icon name={result.value.botWouldAnswer ? "bot" : "user"} size={20} />
        </span>
        <div>
          <strong>{result.value.title}</strong>
          <small>{result.value.detail}</small>
          <ul class="bot-playground-reasons">
            {result.value.matched.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
          {result.value.normalizedPhrase && (
            <small class="bot-playground-normalized">
              El clasificador lee: <code>{result.value.normalizedPhrase}</code>
            </small>
          )}
        </div>
      </div>

      <p class="bot-playground-note">
        Muestra a quién le toca responder, no el texto exacto de la respuesta.
        Ese texto sale de los mensajes configurados más arriba.
      </p>
    </section>
  );
});
