import {
  $,
  component$,
  useSignal,
  useStore,
  useVisibleTask$,
} from "@qwik.dev/core";
import type { DocumentHead } from "@qwik.dev/router";
import { AppNavigation } from "~/components/app/AppNavigation";
import { Icon } from "~/components/ui/Icon";
import { getPageTitle } from "~/config/business";
import { isAdminProfile } from "~/lib/admin-access";
import { formatBusinessDate } from "~/lib/date-time";
import {
  ALL_SURFACES,
  CONDITION_LABELS,
  LOWER_PERMANENT,
  LOWER_PRIMARY,
  SURFACE_CONDITIONS,
  UPPER_PERMANENT,
  UPPER_PRIMARY,
  conditionAllowsSurfaces,
  currentByTooth,
  surfaceLabel,
  toothSummary,
  type OdontogramEntry,
  type ToothCondition,
  type ToothSurface,
} from "~/lib/odontogram";
import { getSupabaseClient } from "~/lib/supabase/client";
import "./odontogram.css";

interface PatientOption {
  id: string;
  name: string;
  phone_e164: string | null;
}

interface EntryRow {
  id: string;
  contact_id: string;
  tooth: number;
  condition: ToothCondition;
  surfaces: Record<string, string> | null;
  note: string | null;
  recorded_at: string;
}

interface OdontogramState {
  loading: boolean;
  isAdmin: boolean;
  userId: string;
  patients: PatientOption[];
  entries: OdontogramEntry[];
  error: string;
}

function mapEntry(row: EntryRow): OdontogramEntry {
  return {
    id: row.id,
    contactId: row.contact_id,
    tooth: row.tooth,
    condition: row.condition,
    surfaces: (row.surfaces ?? {}) as OdontogramEntry["surfaces"],
    note: row.note,
    recordedAt: row.recorded_at,
  };
}

export default component$(() => {
  const state = useStore<OdontogramState>({
    loading: true,
    isAdmin: false,
    userId: "",
    patients: [],
    entries: [],
    error: "",
  });
  const query = useSignal("");
  const patientId = useSignal("");
  const selectedTooth = useSignal<number | null>(null);
  const draftCondition = useSignal<ToothCondition>("caries");
  const draftSurfaces = useStore<Record<string, boolean>>({});
  const draftNote = useSignal("");
  const saving = useSignal(false);
  const entriesLoading = useSignal(false);
  const entryLoadSequence = useSignal(0);
  const notice = useSignal("");
  const noticeKind = useSignal<"success" | "error">("success");

  const loadEntries = $(async (contactId: string, showLoading = true) => {
    const sequence = entryLoadSequence.value + 1;
    entryLoadSequence.value = sequence;
    state.error = "";
    if (!contactId) {
      state.entries = [];
      entriesLoading.value = false;
      return;
    }
    if (showLoading) entriesLoading.value = true;
    const { data, error } = await getSupabaseClient()
      .from("odontogram_entries")
      .select("id,contact_id,tooth,condition,surfaces,note,recorded_at")
      .eq("contact_id", contactId)
      .order("recorded_at", { ascending: true });
    if (sequence !== entryLoadSequence.value) return;
    entriesLoading.value = false;
    if (error) {
      state.error = "No pudimos abrir la ficha clínica.";
      state.entries = [];
      return;
    }
    state.entries = (data ?? []).map((row) => mapEntry(row as EntryRow));
  });

  // El perfil se resuelve sólo en el navegador para no renderizar información
  // clínica antes de saber quién está mirando.
  // eslint-disable-next-line qwik/no-use-visible-task
  useVisibleTask$(async () => {
    const client = getSupabaseClient();
    const {
      data: { user },
    } = await client.auth.getUser();
    if (!user) {
      state.loading = false;
      return;
    }
    state.userId = user.id;

    const { data: profile } = await client
      .from("profiles")
      .select("role,active")
      .eq("id", user.id)
      .single();
    state.isAdmin = isAdminProfile(profile);
    if (!state.isAdmin) {
      state.loading = false;
      return;
    }

    const { data: patients } = await client
      .from("contacts")
      .select("id,name,phone_e164")
      .order("name");
    state.patients = (patients ?? []) as PatientOption[];
    state.loading = false;
  });

  const record = $(async () => {
    const tooth = selectedTooth.value;
    if (!tooth || !patientId.value || saving.value) return;
    saving.value = true;
    const allowed = conditionAllowsSurfaces(draftCondition.value);
    const surfaces: Record<string, string> = {};
    if (allowed) {
      for (const surface of ALL_SURFACES) {
        if (
          draftSurfaces[surface] &&
          SURFACE_CONDITIONS.includes(draftCondition.value)
        ) {
          surfaces[surface] = draftCondition.value;
        }
      }
    }

    const { error } = await getSupabaseClient()
      .from("odontogram_entries")
      .insert({
        contact_id: patientId.value,
        tooth,
        condition: draftCondition.value,
        surfaces,
        note: draftNote.value.trim() || null,
        recorded_by: state.userId,
      });
    if (error) {
      saving.value = false;
      notice.value = "No pudimos guardar el registro.";
      noticeKind.value = "error";
      return;
    }
    draftNote.value = "";
    for (const surface of ALL_SURFACES) draftSurfaces[surface] = false;
    notice.value = "Registro agregado a la ficha.";
    noticeKind.value = "success";
    await loadEntries(patientId.value, false);
    saving.value = false;
  });

  const current = currentByTooth(state.entries);
  const normalizedQuery = query.value.trim().toLocaleLowerCase("es-AR");
  const patients = normalizedQuery
    ? state.patients.filter(
        (patient) =>
          patient.name.toLocaleLowerCase("es-AR").includes(normalizedQuery) ||
          patient.phone_e164?.includes(normalizedQuery),
      )
    : state.patients;
  const selectedPatient = state.patients.find(
    (patient) => patient.id === patientId.value,
  );
  const patientOptions =
    selectedPatient &&
    !patients.some((patient) => patient.id === selectedPatient.id)
      ? [selectedPatient, ...patients]
      : patients;
  const toothHistory = selectedTooth.value
    ? state.entries
        .filter((entry) => entry.tooth === selectedTooth.value)
        .slice()
        .reverse()
    : [];
  const selectedSurfaceCount = ALL_SURFACES.filter(
    (surface) => draftSurfaces[surface],
  ).length;

  const renderRow = (teeth: number[], label: string) => (
    <div class="odontogram-arch">
      <span class="odontogram-arch-label">{label}</span>
      <div class="odontogram-row" role="group" aria-label={label}>
        {teeth.map((tooth) => {
          const entry = current.get(tooth);
          const isSelected = selectedTooth.value === tooth;
          return (
            <button
              key={tooth}
              type="button"
              class={{
                "odontogram-tooth": true,
                selected: isSelected,
                [`condition-${entry?.condition ?? "none"}`]: true,
              }}
              aria-label={`Pieza ${tooth}: ${toothSummary(entry)}${isSelected ? ". Seleccionada" : ""}`}
              aria-pressed={isSelected}
              title={`Pieza ${tooth} · ${toothSummary(entry)}`}
              onClick$={() => {
                selectedTooth.value = tooth;
                draftCondition.value = entry?.condition ?? "caries";
                for (const surface of ALL_SURFACES) {
                  draftSurfaces[surface] = Boolean(entry?.surfaces?.[surface]);
                }
                draftNote.value = "";
                if (window.matchMedia("(max-width: 1100px)").matches) {
                  window.requestAnimationFrame(() => {
                    document
                      .getElementById("odontogram-detail")
                      ?.scrollIntoView({ behavior: "smooth", block: "start" });
                  });
                }
              }}
            >
              <span class="odontogram-tooth-number">{tooth}</span>
              <span class="odontogram-tooth-state" aria-hidden="true">
                <span />
              </span>
              {isSelected && (
                <span class="odontogram-tooth-check" aria-hidden="true">
                  <Icon name="check" size={12} />
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );

  if (state.loading) {
    return (
      <main class="section-shell">
        <AppNavigation active="odontogram" />
        <section id="app-content" class="section-page" tabIndex={-1}>
          <div class="section-empty">Cargando…</div>
        </section>
      </main>
    );
  }

  if (!state.isAdmin) {
    return (
      <main class="section-shell">
        <AppNavigation active="odontogram" />
        <section id="app-content" class="section-page" tabIndex={-1}>
          <div class="section-empty" role="alert">
            <Icon name="alert" size={24} />
            <span>
              <strong>La ficha clínica es de acceso restringido</strong>
              <small>
                Sólo una persona administradora puede ver o registrar
                información clínica.
              </small>
            </span>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main class="section-shell">
      <AppNavigation active="odontogram" />
      <section
        id="app-content"
        class="section-page odontogram-page"
        aria-labelledby="odontogram-title"
        tabIndex={-1}
      >
        <header class="section-page-header">
          <div>
            <span class="eyebrow">Ficha clínica</span>
            <h1 id="odontogram-title">Odontograma</h1>
            <p>
              Estado de cada pieza por paciente. Cada registro se agrega con su
              fecha y no se sobrescribe: para corregir, registrá el estado
              nuevo.
            </p>
          </div>
        </header>

        {state.error && (
          <div class="odontogram-error" role="alert">
            <Icon name="alert" size={21} />
            <span>
              <strong>{state.error}</strong>
              <small>Revisá la conexión y volvé a intentarlo.</small>
            </span>
            {patientId.value && (
              <button
                type="button"
                class="secondary-button"
                onClick$={() => loadEntries(patientId.value)}
              >
                Reintentar
              </button>
            )}
          </div>
        )}

        <section
          class="odontogram-patient-picker"
          aria-labelledby="patient-picker-title"
        >
          <div class="odontogram-picker-heading">
            <span class="odontogram-step" aria-hidden="true">
              1
            </span>
            <div>
              <h2 id="patient-picker-title">Elegí el paciente</h2>
              <p>Buscá por nombre o teléfono y abrí su ficha clínica.</p>
            </div>
          </div>

          <div class="odontogram-picker-controls">
            <label
              class="search-field odontogram-search"
              for="odontogram-patient-search"
            >
              <Icon name="search" size={18} />
              <span class="sr-only">Buscar paciente</span>
              <input
                id="odontogram-patient-search"
                type="search"
                value={query.value}
                placeholder="Nombre o teléfono"
                autocomplete="off"
                onInput$={(_, element) => (query.value = element.value)}
              />
              {query.value && (
                <button
                  type="button"
                  class="odontogram-search-clear"
                  aria-label="Limpiar búsqueda"
                  onClick$={() => (query.value = "")}
                >
                  <Icon name="x" size={16} />
                </button>
              )}
            </label>

            <label class="form-field odontogram-patient-select">
              <span>Paciente</span>
              <span class="odontogram-select-wrap">
                <select
                  value={patientId.value}
                  aria-describedby="odontogram-patient-results"
                  onChange$={async (_, element) => {
                    patientId.value = element.value;
                    selectedTooth.value = null;
                    await loadEntries(element.value);
                  }}
                >
                  <option value="" selected={!patientId.value}>
                    Elegí un paciente
                  </option>
                  {patientOptions.map((patient) => (
                    <option
                      key={patient.id}
                      value={patient.id}
                      selected={patient.id === patientId.value}
                    >
                      {patient.phone_e164
                        ? `${patient.name} · ${patient.phone_e164}`
                        : patient.name}
                    </option>
                  ))}
                </select>
                <Icon name="chevron-down" size={17} />
              </span>
            </label>
          </div>

          <p
            id="odontogram-patient-results"
            class={{
              "odontogram-results": true,
              empty: Boolean(normalizedQuery && !patients.length),
            }}
            role="status"
          >
            {normalizedQuery
              ? patients.length
                ? `${patients.length} ${patients.length === 1 ? "paciente encontrado" : "pacientes encontrados"}`
                : "No encontramos pacientes con esa búsqueda."
              : `${state.patients.length} pacientes disponibles`}
          </p>
        </section>

        {!patientId.value ? (
          <div class="section-empty odontogram-empty">
            <span class="odontogram-empty-icon">
              <Icon name="smile" size={25} />
            </span>
            <strong>El odontograma está listo</strong>
            <span>Elegí un paciente arriba para consultar su ficha.</span>
          </div>
        ) : entriesLoading.value ? (
          <div class="section-empty odontogram-loading" role="status">
            <span class="odontogram-spinner" aria-hidden="true" />
            <strong>Abriendo la ficha de {selectedPatient?.name}</strong>
            <span>Cargando piezas e historial…</span>
          </div>
        ) : (
          <div class="odontogram-workspace">
            <div class="odontogram-patient-summary">
              <span class="odontogram-patient-avatar" aria-hidden="true">
                {selectedPatient?.name.slice(0, 1).toLocaleUpperCase("es-AR")}
              </span>
              <span>
                <small>Ficha abierta</small>
                <strong>{selectedPatient?.name}</strong>
              </span>
              <span class="odontogram-record-count">
                {current.size} de 52 piezas registradas
              </span>
            </div>

            <div class="odontogram-layout">
              <section class="odontogram-chart" aria-labelledby="chart-title">
                <div class="odontogram-chart-heading">
                  <div>
                    <span class="odontogram-step" aria-hidden="true">
                      2
                    </span>
                    <span>
                      <h2 id="chart-title">Seleccioná una pieza</h2>
                      <p>El color muestra el último estado registrado.</p>
                    </span>
                  </div>
                  <details class="odontogram-legend">
                    <summary>Guía de colores</summary>
                    <div class="odontogram-legend-grid">
                      {(Object.keys(CONDITION_LABELS) as ToothCondition[]).map(
                        (condition) => (
                          <span key={condition}>
                            <i
                              class={`condition-swatch condition-${condition}`}
                            >
                              <i />
                            </i>
                            {CONDITION_LABELS[condition]}
                          </span>
                        ),
                      )}
                      <span>
                        <i class="condition-swatch condition-none">
                          <i />
                        </i>
                        Sin registrar
                      </span>
                    </div>
                  </details>
                </div>

                <div class="odontogram-orientation" aria-hidden="true">
                  <span>Derecha del paciente</span>
                  <i />
                  <span>Izquierda del paciente</span>
                </div>

                <section
                  class="odontogram-dentition"
                  aria-labelledby="permanent-title"
                >
                  <h3 id="permanent-title">Dentición permanente</h3>
                  <div class="odontogram-scroll" tabIndex={0}>
                    {renderRow(UPPER_PERMANENT, "Arcada superior permanente")}
                    <span class="odontogram-midline" aria-hidden="true" />
                    {renderRow(LOWER_PERMANENT, "Arcada inferior permanente")}
                  </div>
                </section>

                <section
                  class="odontogram-dentition"
                  aria-labelledby="primary-title"
                >
                  <h3 id="primary-title">Dentición temporaria</h3>
                  <div
                    class="odontogram-scroll odontogram-scroll-primary"
                    tabIndex={0}
                  >
                    {renderRow(UPPER_PRIMARY, "Arcada superior temporaria")}
                    <span class="odontogram-midline" aria-hidden="true" />
                    {renderRow(LOWER_PRIMARY, "Arcada inferior temporaria")}
                  </div>
                </section>
                <p class="odontogram-scroll-hint">
                  <span aria-hidden="true">↔</span> Deslizá horizontalmente para
                  ver todas las piezas
                </p>
              </section>

              <aside
                id="odontogram-detail"
                class="odontogram-detail"
                aria-labelledby={
                  selectedTooth.value ? "tooth-detail-title" : undefined
                }
                tabIndex={-1}
              >
                {selectedTooth.value ? (
                  <>
                    <header class="odontogram-detail-heading">
                      <span>
                        <small>Pieza seleccionada</small>
                        <h2 id="tooth-detail-title">
                          Pieza {selectedTooth.value}
                        </h2>
                      </span>
                      <button
                        type="button"
                        class="odontogram-close-button"
                        aria-label={`Cerrar detalle de la pieza ${selectedTooth.value}`}
                        onClick$={() => (selectedTooth.value = null)}
                      >
                        <Icon name="x" size={18} />
                      </button>
                    </header>

                    <div class="odontogram-current" role="status">
                      <i
                        class={`condition-swatch condition-${current.get(selectedTooth.value)?.condition ?? "none"}`}
                        aria-hidden="true"
                      >
                        <i />
                      </i>
                      <span>
                        <small>Estado actual</small>
                        <strong>
                          {toothSummary(current.get(selectedTooth.value))}
                        </strong>
                      </span>
                    </div>

                    <div class="odontogram-form-heading">
                      <h3>Nuevo registro</h3>
                      <p>Se agregará al historial sin borrar los anteriores.</p>
                    </div>

                    <label class="form-field odontogram-condition-field">
                      <span>Registrar estado</span>
                      <span class="odontogram-select-wrap">
                        <select
                          value={draftCondition.value}
                          onChange$={(_, element) =>
                            (draftCondition.value =
                              element.value as ToothCondition)
                          }
                        >
                          {(
                            Object.keys(CONDITION_LABELS) as ToothCondition[]
                          ).map((condition) => (
                            <option
                              key={condition}
                              value={condition}
                              selected={condition === draftCondition.value}
                            >
                              {CONDITION_LABELS[condition]}
                            </option>
                          ))}
                        </select>
                        <Icon name="chevron-down" size={17} />
                      </span>
                    </label>

                    {SURFACE_CONDITIONS.includes(draftCondition.value) && (
                      <fieldset class="odontogram-surfaces">
                        <legend>
                          Caras afectadas
                          <small>
                            {selectedSurfaceCount
                              ? `${selectedSurfaceCount} ${selectedSurfaceCount === 1 ? "seleccionada" : "seleccionadas"}`
                              : "Ninguna seleccionada"}
                          </small>
                        </legend>
                        <p>Podés marcar más de una.</p>
                        <div class="odontogram-surface-grid">
                          {ALL_SURFACES.map((surface: ToothSurface) => (
                            <label
                              key={surface}
                              class="odontogram-surface-option"
                            >
                              <input
                                type="checkbox"
                                checked={Boolean(draftSurfaces[surface])}
                                onChange$={(_, element) =>
                                  (draftSurfaces[surface] = element.checked)
                                }
                              />
                              <span>
                                <i aria-hidden="true">
                                  <Icon name="check" size={13} />
                                </i>
                                {surfaceLabel(
                                  selectedTooth.value ?? 11,
                                  surface,
                                )}
                              </span>
                            </label>
                          ))}
                        </div>
                      </fieldset>
                    )}

                    <label class="form-field odontogram-note-field">
                      <span>
                        Nota <em>Opcional</em>
                      </span>
                      <textarea
                        rows={3}
                        maxLength={2000}
                        value={draftNote.value}
                        placeholder="Ej.: control, evolución o indicación clínica"
                        aria-describedby="odontogram-note-count"
                        onInput$={(_, element) =>
                          (draftNote.value = element.value)
                        }
                      />
                      <small
                        id="odontogram-note-count"
                        class="odontogram-note-count"
                      >
                        {draftNote.value.length} / 2000
                      </small>
                    </label>

                    <button
                      class="primary-button odontogram-save-button"
                      type="button"
                      disabled={saving.value}
                      aria-busy={saving.value}
                      onClick$={record}
                    >
                      {saving.value ? (
                        <>
                          <span
                            class="odontogram-button-spinner"
                            aria-hidden="true"
                          />
                          Guardando registro…
                        </>
                      ) : (
                        <>
                          <Icon name="check" size={17} />
                          Agregar a la ficha
                        </>
                      )}
                    </button>

                    <section
                      class="odontogram-history-section"
                      aria-labelledby="history-title"
                    >
                      <div class="odontogram-history-heading">
                        <h3 id="history-title">Historial</h3>
                        <span>{toothHistory.length}</span>
                      </div>
                      {toothHistory.length ? (
                        <ol class="odontogram-history">
                          {toothHistory.map((entry, index) => (
                            <li key={entry.id}>
                              <i
                                class={`condition-swatch condition-${entry.condition}`}
                                aria-hidden="true"
                              >
                                <i />
                              </i>
                              <span>
                                <strong>{toothSummary(entry)}</strong>
                                <small>
                                  {formatBusinessDate(
                                    new Date(entry.recordedAt),
                                    {
                                      dateStyle: "medium",
                                      timeStyle: "short",
                                    },
                                  )}
                                  {index === 0 && <em>Actual</em>}
                                </small>
                                {entry.note && <p>{entry.note}</p>}
                              </span>
                            </li>
                          ))}
                        </ol>
                      ) : (
                        <p class="odontogram-history-empty">
                          Esta pieza todavía no tiene registros.
                        </p>
                      )}
                    </section>
                  </>
                ) : (
                  <div class="odontogram-detail-empty">
                    <span aria-hidden="true">
                      <Icon name="plus" size={22} />
                    </span>
                    <strong>Elegí una pieza</strong>
                    <p>
                      Seleccioná un número del odontograma para ver su estado,
                      historial o agregar un registro.
                    </p>
                  </div>
                )}
              </aside>
            </div>
          </div>
        )}

        {selectedPatient && (
          <p class="settings-note odontogram-privacy">
            <Icon name="info" size={16} /> Información clínica de{" "}
            {selectedPatient.name}. No se envía por WhatsApp ni la usa la
            automatización.
          </p>
        )}
      </section>

      {notice.value && (
        <div
          class={{ toast: true, error: noticeKind.value === "error" }}
          role={noticeKind.value === "error" ? "alert" : "status"}
          aria-live={noticeKind.value === "error" ? "assertive" : "polite"}
        >
          <span>{notice.value}</span>
          <button
            type="button"
            aria-label="Cerrar notificación"
            onClick$={() => (notice.value = "")}
          >
            <Icon name="x" size={17} />
          </button>
        </div>
      )}
    </main>
  );
});

export const head: DocumentHead = {
  title: getPageTitle("Odontograma"),
  meta: [
    {
      name: "description",
      content: "Ficha clínica odontológica por paciente.",
    },
  ],
};
