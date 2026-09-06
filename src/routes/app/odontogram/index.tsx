import {
  $,
  component$,
  useSignal,
  useStore,
  useVisibleTask$,
} from "@qwik.dev/core";
import { usePreventNavigate$, type DocumentHead } from "@qwik.dev/router";
import { AppNavigation } from "~/components/app/AppNavigation";
import { Icon } from "~/components/ui/Icon";
import { getPageTitle } from "~/config/business";
import { isAdminProfile } from "~/lib/admin-access";
import { formatBusinessDate } from "~/lib/date-time";
import {
  ALL_SURFACES,
  ALL_TEETH,
  CONDITION_LABELS,
  LOWER_PERMANENT,
  LOWER_PRIMARY,
  SURFACE_CONDITIONS,
  UPPER_PERMANENT,
  UPPER_PRIMARY,
  conditionAllowsSurfaces,
  currentByTooth,
  isPrimaryTooth,
  isUpperTooth,
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
  entry_sequence: number;
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
    entrySequence: row.entry_sequence,
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
  const draftSurfaces = useStore<
    Partial<Record<ToothSurface, ToothCondition | "">>
  >({});
  const draftDirty = useSignal(false);
  const dentition = useSignal<"permanent" | "primary" | "mixed">("permanent");
  const draftNote = useSignal("");
  const saving = useSignal(false);
  const entriesLoading = useSignal(false);
  const entryLoadSequence = useSignal(0);
  const notice = useSignal("");
  const noticeKind = useSignal<"success" | "error">("success");

  const loadEntries = $(async (contactId: string) => {
    const sequence = ++entryLoadSequence.value;
    state.error = "";
    state.entries = [];
    if (!contactId) {
      entriesLoading.value = false;
      return;
    }
    entriesLoading.value = true;
    try {
      // Paginar por secuencia evita truncar fichas extensas o perder el orden
      // cuando otro registro se agrega mientras se consulta el historial.
      const entries: OdontogramEntry[] = [];
      let before: number | undefined;
      while (sequence === entryLoadSequence.value) {
        let request = getSupabaseClient()
          .from("odontogram_entries")
          .select(
            "id,contact_id,tooth,condition,surfaces,note,recorded_at,entry_sequence",
          )
          .eq("contact_id", contactId)
          .order("entry_sequence", { ascending: false })
          .limit(500);
        if (before !== undefined)
          request = request.lt("entry_sequence", before);
        const { data, error } = await request;
        if (sequence !== entryLoadSequence.value) return;
        if (error) throw error;
        const rows = (data ?? []) as EntryRow[];
        entries.push(...rows.map(mapEntry));
        if (rows.length < 500) break;
        before = rows[rows.length - 1].entry_sequence;
      }
      if (sequence === entryLoadSequence.value) state.entries = entries;
    } catch {
      if (sequence === entryLoadSequence.value) {
        state.error = "No pudimos abrir la ficha clínica.";
      }
    } finally {
      if (sequence === entryLoadSequence.value) entriesLoading.value = false;
    }
  });

  const discardDraft = $(() => {
    if (saving.value) return false;
    if (
      draftDirty.value &&
      !window.confirm(
        "Hay cambios sin guardar en esta pieza. ¿Querés descartarlos?",
      )
    )
      return false;
    draftDirty.value = false;
    return true;
  });

  usePreventNavigate$((target) => {
    if (!draftDirty.value && !saving.value) return false;
    if (target === undefined || saving.value) return true;
    const discard = window.confirm(
      "Hay cambios sin guardar en esta pieza. ¿Querés salir y descartarlos?",
    );
    if (discard) draftDirty.value = false;
    return !discard;
  });

  const chooseTooth = $(async (tooth: number) => {
    if (selectedTooth.value === tooth || !(await discardDraft())) return;
    const entry = currentByTooth(state.entries).get(tooth);
    selectedTooth.value = tooth;
    if (dentition.value !== "mixed")
      dentition.value = isPrimaryTooth(tooth) ? "primary" : "permanent";
    draftCondition.value = entry?.condition ?? "caries";
    for (const surface of ALL_SURFACES)
      draftSurfaces[surface] = entry?.surfaces[surface] ?? "";
    draftNote.value = "";
    notice.value = "";
    window.requestAnimationFrame(() => {
      const detail = document.getElementById("odontogram-detail");
      detail?.focus({ preventScroll: true });
      if (window.matchMedia("(max-width: 1320px)").matches) {
        detail?.scrollIntoView({
          behavior: window.matchMedia("(prefers-reduced-motion: reduce)")
            .matches
            ? "instant"
            : "smooth",
          block: "start",
        });
      }
    });
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

    const { data: patients, error } = await client
      .from("contacts")
      .select("id,name,phone_e164")
      .order("name");
    state.patients = (patients ?? []) as PatientOption[];
    if (error)
      state.error =
        "No pudimos cargar los pacientes. Recargá la página para reintentar.";
    state.loading = false;
  });

  const record = $(async () => {
    const tooth = selectedTooth.value;
    const contactId = patientId.value;
    if (
      !tooth ||
      !contactId ||
      saving.value ||
      entriesLoading.value ||
      state.error ||
      !state.isAdmin
    )
      return;
    saving.value = true;
    notice.value = "";
    const condition = draftCondition.value;
    const surfaces: Partial<Record<ToothSurface, ToothCondition>> = {};
    if (conditionAllowsSurfaces(condition)) {
      for (const surface of ALL_SURFACES) {
        const finding = draftSurfaces[surface];
        if (finding && SURFACE_CONDITIONS.includes(finding))
          surfaces[surface] = finding;
      }
    }
    try {
      const { data, error } = await getSupabaseClient()
        .from("odontogram_entries")
        .insert({
          contact_id: contactId,
          tooth,
          condition,
          surfaces,
          note: draftNote.value.trim() || null,
          recorded_by: state.userId,
        })
        .select(
          "id,contact_id,tooth,condition,surfaces,note,recorded_at,entry_sequence",
        )
        .single();
      if (error || !data) throw error;
      // El registro devuelto por el servidor ya tiene fecha y secuencia.
      // No depende de una segunda consulta que podría fallar tras guardar.
      if (patientId.value === contactId)
        state.entries = [mapEntry(data as EntryRow), ...state.entries];
      draftNote.value = "";
      draftDirty.value = false;
      notice.value = `Pieza ${tooth}: registro guardado en la ficha.`;
      noticeKind.value = "success";
    } catch {
      notice.value =
        "No pudimos confirmar el guardado. Tus cambios siguen acá; revisá la ficha antes de repetirlo.";
      noticeKind.value = "error";
    } finally {
      saving.value = false;
    }
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
        .sort((a, b) => b.entrySequence - a.entrySequence)
    : [];
  const selectedSurfaceCount = ALL_SURFACES.filter(
    (surface) => draftSurfaces[surface],
  ).length;

  const renderRow = (teeth: number[], label: string) => (
    <div class="odontogram-arch">
      <span class="odontogram-arch-label">
        {label.includes("superior") ? "Superior" : "Inferior"}
      </span>
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
              id={`odontogram-tooth-${tooth}`}
              disabled={saving.value}
              onClick$={() => chooseTooth(tooth)}
            >
              <span class="odontogram-tooth-number">{tooth}</span>
              <span class="odontogram-tooth-state" aria-hidden="true">
                <span />
              </span>
              <span class="odontogram-tooth-code" aria-hidden="true">
                {entry ? CONDITION_LABELS[entry.condition].slice(0, 3) : "—"}
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
                  disabled={saving.value}
                  aria-describedby="odontogram-patient-results"
                  onChange$={async (_, element) => {
                    if (!(await discardDraft())) {
                      element.value = patientId.value;
                      return;
                    }
                    patientId.value = element.value;
                    selectedTooth.value = null;
                    notice.value = "";
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
        ) : state.error ? (
          <div class="section-empty odontogram-empty">
            <strong>La ficha no está disponible</strong>
            <span>
              Reintentá la carga para consultar y registrar información.
            </span>
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
                {current.size}{" "}
                {current.size === 1 ? "pieza registrada" : "piezas registradas"}
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
                      <p>Consultá el estado y agregá hallazgos por cara.</p>
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

                <div class="odontogram-chart-tools">
                  <div
                    class="odontogram-dentition-toggle"
                    role="group"
                    aria-label="Dentición visible"
                  >
                    {(
                      [
                        ["permanent", "Permanente"],
                        ["primary", "Temporaria"],
                        ["mixed", "Mixta"],
                      ] as const
                    ).map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        aria-pressed={dentition.value === value}
                        onClick$={() => {
                          dentition.value = value;
                        }}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <label class="odontogram-quick-select">
                    <span>Ir a pieza</span>
                    <select
                      value={selectedTooth.value ?? ""}
                      disabled={saving.value}
                      onChange$={async (_, element) => {
                        if (element.value)
                          await chooseTooth(Number(element.value));
                        element.value = String(selectedTooth.value ?? "");
                      }}
                    >
                      <option value="">Elegí una pieza</option>
                      <optgroup label="Permanentes">
                        {ALL_TEETH.filter(
                          (tooth) => !isPrimaryTooth(tooth),
                        ).map((tooth) => (
                          <option key={tooth} value={String(tooth)}>
                            {`Pieza ${tooth} · ${toothSummary(current.get(tooth))}`}
                          </option>
                        ))}
                      </optgroup>
                      <optgroup label="Temporarias">
                        {ALL_TEETH.filter(isPrimaryTooth).map((tooth) => (
                          <option key={tooth} value={String(tooth)}>
                            {`Pieza ${tooth} · ${toothSummary(current.get(tooth))}`}
                          </option>
                        ))}
                      </optgroup>
                    </select>
                  </label>
                </div>

                <div class="odontogram-orientation" aria-hidden="true">
                  <span>Derecha del paciente</span>
                  <i />
                  <span>Izquierda del paciente</span>
                </div>

                <section
                  class="odontogram-dentition"
                  hidden={dentition.value === "primary"}
                  aria-labelledby="permanent-title"
                >
                  <h3 id="permanent-title">Dentición permanente</h3>
                  <div
                    class="odontogram-scroll"
                    tabIndex={0}
                    role="region"
                    aria-label="Piezas permanentes, desplazamiento horizontal"
                  >
                    {renderRow(UPPER_PERMANENT, "Arcada superior permanente")}
                    <span class="odontogram-midline" aria-hidden="true" />
                    {renderRow(LOWER_PERMANENT, "Arcada inferior permanente")}
                  </div>
                </section>

                <section
                  class="odontogram-dentition"
                  hidden={dentition.value === "permanent"}
                  aria-labelledby="primary-title"
                >
                  <h3 id="primary-title">Dentición temporaria</h3>
                  <div
                    class="odontogram-scroll odontogram-scroll-primary"
                    tabIndex={0}
                    role="region"
                    aria-label="Piezas temporarias, desplazamiento horizontal"
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
                        <small>
                          {isPrimaryTooth(selectedTooth.value)
                            ? "Temporaria"
                            : "Permanente"}{" "}
                          ·{" "}
                          {isUpperTooth(selectedTooth.value)
                            ? "Superior"
                            : "Inferior"}
                        </small>
                        <h2 id="tooth-detail-title">
                          Pieza {selectedTooth.value}
                        </h2>
                      </span>
                      <button
                        type="button"
                        class="odontogram-close-button"
                        aria-label={`Cerrar detalle de la pieza ${selectedTooth.value}`}
                        disabled={saving.value}
                        onClick$={async () => {
                          if (!(await discardDraft())) return;
                          const tooth = selectedTooth.value;
                          selectedTooth.value = null;
                          document
                            .getElementById(`odontogram-tooth-${tooth}`)
                            ?.focus();
                        }}
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
                      <p>
                        Para {selectedPatient?.name} · Pieza{" "}
                        {selectedTooth.value}. Los registros anteriores se
                        conservan.
                      </p>
                    </div>

                    <label class="form-field odontogram-condition-field">
                      <span>Registrar estado</span>
                      <span class="odontogram-select-wrap">
                        <select
                          value={draftCondition.value}
                          disabled={saving.value}
                          onChange$={(_, element) => {
                            draftCondition.value =
                              element.value as ToothCondition;
                            draftDirty.value = true;
                            if (!conditionAllowsSurfaces(draftCondition.value))
                              for (const surface of ALL_SURFACES)
                                draftSurfaces[surface] = "";
                          }}
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

                    {conditionAllowsSurfaces(draftCondition.value) ? (
                      <fieldset
                        class="odontogram-surfaces"
                        disabled={saving.value}
                      >
                        <legend>
                          Hallazgos por cara{" "}
                          <small>{selectedSurfaceCount} registradas</small>
                        </legend>
                        <p>
                          Podés registrar un hallazgo diferente en cada cara. Si
                          no indicás caras, el estado describe la pieza
                          completa.
                        </p>
                        <div class="odontogram-surface-fields">
                          {ALL_SURFACES.map((surface) => (
                            <label
                              key={surface}
                              class={{
                                "odontogram-surface-field": true,
                                "has-finding": Boolean(draftSurfaces[surface]),
                              }}
                            >
                              <span>
                                {surfaceLabel(
                                  selectedTooth.value ?? 11,
                                  surface,
                                )}
                              </span>
                              <select
                                value={draftSurfaces[surface] || ""}
                                onChange$={(_, element) => {
                                  draftSurfaces[surface] = element.value as
                                    | ToothCondition
                                    | "";
                                  draftDirty.value = true;
                                }}
                              >
                                <option
                                  value=""
                                  selected={!draftSurfaces[surface]}
                                >
                                  Sin hallazgo
                                </option>
                                {SURFACE_CONDITIONS.map((condition) => (
                                  <option
                                    key={condition}
                                    value={condition}
                                    selected={
                                      draftSurfaces[surface] === condition
                                    }
                                  >
                                    {CONDITION_LABELS[condition]}
                                  </option>
                                ))}
                              </select>
                            </label>
                          ))}
                        </div>
                      </fieldset>
                    ) : (
                      <p class="odontogram-whole-tooth-note">
                        Este estado se registra para la pieza completa, sin
                        hallazgos por cara.
                      </p>
                    )}

                    <label class="form-field odontogram-note-field">
                      <span>
                        Nota <em>Opcional</em>
                      </span>
                      <textarea
                        rows={3}
                        maxLength={2000}
                        disabled={saving.value}
                        value={draftNote.value}
                        placeholder="Ej.: control, evolución o indicación clínica"
                        aria-describedby="odontogram-note-count"
                        onInput$={(_, element) => {
                          draftNote.value = element.value;
                          draftDirty.value = true;
                        }}
                      />
                      <small
                        id="odontogram-note-count"
                        class="odontogram-note-count"
                      >
                        {draftNote.value.length} / 2000
                      </small>
                    </label>

                    {draftDirty.value && (
                      <p class="odontogram-draft-status" role="status">
                        Cambios sin guardar · Pieza {selectedTooth.value}
                      </p>
                    )}
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
                          Guardar pieza {selectedTooth.value}
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
                                  <time dateTime={entry.recordedAt}>
                                    {formatBusinessDate(
                                      new Date(entry.recordedAt),
                                      {
                                        dateStyle: "medium",
                                        timeStyle: "short",
                                      },
                                    )}
                                  </time>
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
