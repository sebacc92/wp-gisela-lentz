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
  const notice = useSignal("");

  const loadEntries = $(async (contactId: string) => {
    if (!contactId) {
      state.entries = [];
      return;
    }
    const { data, error } = await getSupabaseClient()
      .from("odontogram_entries")
      .select("id,contact_id,tooth,condition,surfaces,note,recorded_at")
      .eq("contact_id", contactId)
      .order("recorded_at", { ascending: true });
    if (error) {
      state.error = "No pudimos abrir la ficha clínica.";
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
    saving.value = false;
    if (error) {
      notice.value = "No pudimos guardar el registro.";
      return;
    }
    draftNote.value = "";
    for (const surface of ALL_SURFACES) draftSurfaces[surface] = false;
    notice.value = "Registro agregado a la ficha.";
    await loadEntries(patientId.value);
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
  const toothHistory = selectedTooth.value
    ? state.entries
        .filter((entry) => entry.tooth === selectedTooth.value)
        .slice()
        .reverse()
    : [];

  const renderRow = (teeth: number[]) => (
    <div class="odontogram-row">
      {teeth.map((tooth) => {
        const entry = current.get(tooth);
        return (
          <button
            key={tooth}
            type="button"
            class={{
              "odontogram-tooth": true,
              selected: selectedTooth.value === tooth,
              [`condition-${entry?.condition ?? "none"}`]: true,
            }}
            aria-label={`Pieza ${tooth}: ${toothSummary(entry)}`}
            onClick$={() => {
              selectedTooth.value = tooth;
              draftCondition.value = entry?.condition ?? "caries";
              for (const surface of ALL_SURFACES) {
                draftSurfaces[surface] = Boolean(entry?.surfaces?.[surface]);
              }
              draftNote.value = "";
            }}
          >
            <span class="odontogram-tooth-number">{tooth}</span>
            <span class="odontogram-tooth-state" aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );

  if (state.loading) {
    return (
      <main class="section-shell">
        <AppNavigation active="odontogram" />
        <section class="section-page">
          <div class="section-empty">Cargando…</div>
        </section>
      </main>
    );
  }

  if (!state.isAdmin) {
    return (
      <main class="section-shell">
        <AppNavigation active="odontogram" />
        <section class="section-page">
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
      <section class="section-page odontogram-page">
        <header class="section-page-header">
          <div>
            <span class="eyebrow">Ficha clínica</span>
            <h1>Odontograma</h1>
            <p>
              Estado de cada pieza por paciente. Cada registro se agrega con su
              fecha y no se sobrescribe: para corregir, registrá el estado
              nuevo.
            </p>
          </div>
        </header>

        {state.error && (
          <div class="section-empty" role="alert">
            <Icon name="alert" size={24} />
            <span>{state.error}</span>
          </div>
        )}

        <label class="search-field">
          <Icon name="search" size={18} />
          <span class="sr-only">Buscar paciente</span>
          <input
            type="search"
            value={query.value}
            placeholder="Buscar por nombre o teléfono"
            onInput$={(_, element) => (query.value = element.value)}
          />
        </label>

        <label class="form-field">
          <span>Paciente</span>
          <select
            value={patientId.value}
            onChange$={async (_, element) => {
              patientId.value = element.value;
              selectedTooth.value = null;
              await loadEntries(element.value);
            }}
          >
            <option value="">Elegí un paciente</option>
            {patients.map((patient) => (
              <option key={patient.id} value={patient.id}>
                {patient.phone_e164
                  ? `${patient.name} · ${patient.phone_e164}`
                  : patient.name}
              </option>
            ))}
          </select>
        </label>

        {!patientId.value ? (
          <div class="section-empty">
            <Icon name="smile" size={24} />
            <span>Elegí un paciente para ver su odontograma.</span>
          </div>
        ) : (
          <div class="odontogram-layout">
            <div class="odontogram-chart">
              <h2>Dentición permanente</h2>
              {renderRow(UPPER_PERMANENT)}
              {renderRow(LOWER_PERMANENT)}
              <h2>Dentición temporaria</h2>
              {renderRow(UPPER_PRIMARY)}
              {renderRow(LOWER_PRIMARY)}
            </div>

            <aside class="odontogram-detail">
              {selectedTooth.value ? (
                <>
                  <h2>Pieza {selectedTooth.value}</h2>
                  <p class="odontogram-current">
                    Estado actual:{" "}
                    {toothSummary(current.get(selectedTooth.value))}
                  </p>

                  <label class="form-field">
                    <span>Registrar estado</span>
                    <select
                      value={draftCondition.value}
                      onChange$={(_, element) =>
                        (draftCondition.value = element.value as ToothCondition)
                      }
                    >
                      {(Object.keys(CONDITION_LABELS) as ToothCondition[]).map(
                        (condition) => (
                          <option key={condition} value={condition}>
                            {CONDITION_LABELS[condition]}
                          </option>
                        ),
                      )}
                    </select>
                  </label>

                  {SURFACE_CONDITIONS.includes(draftCondition.value) && (
                    <fieldset class="odontogram-surfaces">
                      <legend>Caras afectadas</legend>
                      {ALL_SURFACES.map((surface: ToothSurface) => (
                        <label key={surface} class="settings-checkbox">
                          <input
                            type="checkbox"
                            checked={Boolean(draftSurfaces[surface])}
                            onChange$={(_, element) =>
                              (draftSurfaces[surface] = element.checked)
                            }
                          />
                          <span>
                            {surfaceLabel(selectedTooth.value ?? 11, surface)}
                          </span>
                        </label>
                      ))}
                    </fieldset>
                  )}

                  <label class="form-field">
                    <span>
                      Nota <em>Opcional</em>
                    </span>
                    <textarea
                      rows={3}
                      maxLength={2000}
                      value={draftNote.value}
                      onInput$={(_, element) =>
                        (draftNote.value = element.value)
                      }
                    />
                  </label>

                  <button
                    class="primary-button"
                    type="button"
                    disabled={saving.value}
                    onClick$={record}
                  >
                    {saving.value ? "Guardando…" : "Agregar a la ficha"}
                  </button>

                  <h3>Historial de la pieza</h3>
                  {toothHistory.length ? (
                    <ol class="odontogram-history">
                      {toothHistory.map((entry) => (
                        <li key={entry.id}>
                          <strong>{toothSummary(entry)}</strong>
                          <small>
                            {formatBusinessDate(new Date(entry.recordedAt), {
                              dateStyle: "medium",
                              timeStyle: "short",
                            })}
                          </small>
                          {entry.note && <p>{entry.note}</p>}
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p class="settings-note">
                      Esta pieza todavía no tiene registros.
                    </p>
                  )}
                </>
              ) : (
                <p class="settings-note">
                  Elegí una pieza del odontograma para ver su historial o
                  registrar un estado nuevo.
                </p>
              )}
            </aside>
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
        <div class="toast" role="status">
          <span>{notice.value}</span>
          <button type="button" onClick$={() => (notice.value = "")}>
            ×
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
