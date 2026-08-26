import {
  $,
  component$,
  useSignal,
  useStore,
  useVisibleTask$,
} from "@qwik.dev/core";
import type { DocumentHead } from "@qwik.dev/router";
import { Link } from "@qwik.dev/router";
import { AppNavigation } from "~/components/app/AppNavigation";
import { Icon } from "~/components/ui/Icon";
import { getPageTitle } from "~/config/business";
import { formatBusinessDate } from "~/lib/date-time";
import {
  appointmentDisplayStatus,
  appointmentStatusTone,
  coverageLabel,
  effectiveDepositStatus,
} from "~/lib/booking";
import type { DepositStatus, PatientCoverage } from "~/lib/inbox-types";
import { normalizePhoneE164 } from "~/lib/phone";
import { getSupabaseClient } from "~/lib/supabase/client";

interface PatientRow {
  id: string;
  name: string;
  phone_e164: string | null;
  whatsapp_user_id: string | null;
  email: string | null;
  administrative_notes: string | null;
  created_at: string;
  coverage: PatientCoverage | null;
  is_existing_patient: boolean | null;
  alternate_phone_e164: string | null;
}

interface AppointmentRow {
  id: string;
  contact_id: string;
  starts_at: string;
  status: "scheduled" | "confirmed" | "cancelled" | "completed" | "no_show";
  deposit_status: DepositStatus;
  hold_expires_at: string | null;
  services: { name: string } | Array<{ name: string }> | null;
}

interface ConversationRow {
  id: string;
  contact_id: string;
  status: "open" | "closed";
}

interface PatientView extends PatientRow {
  lastAppointment: AppointmentRow | null;
  nextAppointment: AppointmentRow | null;
  appointments: AppointmentRow[];
  conversationId: string | null;
}

function relationName(value: AppointmentRow["services"]): string {
  const service = Array.isArray(value) ? value[0] : value;
  return service?.name ?? "Consulta";
}

function formatAppointment(value: string): string {
  return formatBusinessDate(new Date(value), {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function whatsappIdentityLabel(patient: PatientRow): string {
  return patient.phone_e164 ?? "Identidad privada de WhatsApp";
}

export default component$(() => {
  const query = useSignal("");
  const selectedId = useSignal("");
  const editorOpen = useSignal(false);
  const notice = useSignal("");
  const reloadVersion = useSignal(0);
  const editor = useStore({
    id: "",
    name: "",
    phone: "",
    email: "",
    notes: "",
    coverage: "" as PatientCoverage | "",
    isExistingPatient: null as boolean | null,
    alternatePhone: "",
    saving: false,
    error: "",
  });
  const state = useStore<{
    patients: PatientView[];
    loading: boolean;
    error: boolean;
  }>({ patients: [], loading: true, error: false });

  const loadPatients = $(async () => {
    state.loading = true;
    state.error = false;
    try {
      const client = getSupabaseClient();
      const [contactsResult, appointmentsResult, conversationsResult] =
        await Promise.all([
          client
            .from("contacts")
            .select(
              "id,name,phone_e164,whatsapp_user_id,email,administrative_notes,created_at,coverage,is_existing_patient,alternate_phone_e164",
            )
            .order("name"),
          client
            .from("appointments")
            .select(
              "id,contact_id,starts_at,status,deposit_status,hold_expires_at,services!appointments_service_id_fkey(name)",
            )
            .order("starts_at"),
          client.from("conversations").select("id,contact_id,status"),
        ]);
      if (contactsResult.error) throw contactsResult.error;
      if (appointmentsResult.error) throw appointmentsResult.error;
      if (conversationsResult.error) throw conversationsResult.error;

      const now = Date.now();
      const appointments = (appointmentsResult.data ??
        []) as unknown as AppointmentRow[];
      const conversations = (conversationsResult.data ??
        []) as ConversationRow[];
      state.patients = ((contactsResult.data ?? []) as PatientRow[]).map(
        (patient) => {
          const patientAppointments = appointments.filter(
            (appointment) => appointment.contact_id === patient.id,
          );
          const past = patientAppointments.filter(
            (appointment) => new Date(appointment.starts_at).getTime() < now,
          );
          const future = patientAppointments.filter((appointment) => {
            const depositStatus = effectiveDepositStatus(
              appointment.status,
              appointment.deposit_status,
              appointment.hold_expires_at,
              now,
            );
            return (
              new Date(appointment.starts_at).getTime() >= now &&
              (appointment.status === "scheduled" ||
                appointment.status === "confirmed") &&
              depositStatus !== "expired"
            );
          });
          const conversation = conversations.find(
            (item) => item.contact_id === patient.id && item.status === "open",
          );
          return {
            ...patient,
            lastAppointment: past[past.length - 1] ?? null,
            nextAppointment: future[0] ?? null,
            appointments: [...patientAppointments].reverse(),
            conversationId: conversation?.id ?? null,
          };
        },
      );
      if (
        selectedId.value &&
        !state.patients.some((patient) => patient.id === selectedId.value)
      ) {
        selectedId.value = "";
      }
    } catch {
      state.error = true;
    } finally {
      state.loading = false;
    }
  });

  useVisibleTask$(async ({ track }) => {
    track(() => reloadVersion.value);
    await loadPatients();
  });

  const openEditor = $((patient?: PatientView) => {
    editor.id = patient?.id ?? "";
    editor.name = patient?.name ?? "";
    editor.phone = patient?.phone_e164 ?? "";
    editor.email = patient?.email ?? "";
    editor.notes = patient?.administrative_notes ?? "";
    editor.coverage = patient?.coverage ?? "";
    editor.isExistingPatient = patient?.is_existing_patient ?? null;
    editor.alternatePhone = patient?.alternate_phone_e164 ?? "";
    editor.error = "";
    editorOpen.value = true;
  });

  const normalizedQuery = query.value.trim().toLocaleLowerCase("es-AR");
  const patients = state.patients.filter(
    (patient) =>
      !normalizedQuery ||
      patient.name.toLocaleLowerCase("es-AR").includes(normalizedQuery) ||
      patient.phone_e164?.includes(normalizedQuery) ||
      patient.whatsapp_user_id?.includes(normalizedQuery) ||
      patient.alternate_phone_e164?.includes(normalizedQuery) ||
      patient.email?.toLocaleLowerCase("es-AR").includes(normalizedQuery),
  );
  const selected = state.patients.find(
    (patient) => patient.id === selectedId.value,
  );

  return (
    <main class="section-shell">
      <AppNavigation active="patients" />
      <section class="section-page patients-page">
        <header class="section-page-header">
          <div>
            <span class="eyebrow">Agenda administrativa</span>
            <h1>Pacientes</h1>
            <p>Datos de contacto y turnos, sin información clínica.</p>
          </div>
          <button
            class="primary-button"
            type="button"
            onClick$={() => openEditor()}
          >
            <Icon name="plus" size={17} /> Nuevo paciente
          </button>
        </header>

        <label class="search-field patients-search">
          <Icon name="search" size={18} />
          <span class="sr-only">Buscar paciente</span>
          <input
            type="search"
            value={query.value}
            placeholder="Buscar por nombre, teléfono o email"
            onInput$={(_, element) => (query.value = element.value)}
          />
        </label>

        {state.loading ? (
          <div class="section-empty">
            <span class="small-spinner" />
            <p>Cargando pacientes…</p>
          </div>
        ) : state.error ? (
          <div class="section-empty">
            <Icon name="alert" size={24} />
            <p>No pudimos cargar los pacientes.</p>
            <button type="button" onClick$={() => (reloadVersion.value += 1)}>
              Reintentar
            </button>
          </div>
        ) : patients.length === 0 ? (
          <div class="section-empty">
            <Icon name="user" size={26} />
            <p>
              {query.value
                ? "No encontramos pacientes con esa búsqueda."
                : "Todavía no hay pacientes registrados."}
            </p>
          </div>
        ) : (
          <div class="patients-list" role="list">
            {patients.map((patient) => (
              <button
                class="patient-row"
                type="button"
                role="listitem"
                key={patient.id}
                onClick$={() => (selectedId.value = patient.id)}
              >
                <span class="agenda-avatar">
                  {patient.name
                    .split(/\s+/)
                    .slice(0, 2)
                    .map((part) => part[0])
                    .join("")}
                </span>
                <span class="patient-main">
                  <strong>{patient.name}</strong>
                  <small>
                    {coverageLabel(patient.coverage)} ·{" "}
                    {whatsappIdentityLabel(patient)}
                  </small>
                </span>
                <span class="patient-appointment">
                  <small>Próximo turno</small>
                  <strong>
                    {patient.nextAppointment
                      ? formatAppointment(patient.nextAppointment.starts_at)
                      : "Sin turno"}
                  </strong>
                </span>
                <Icon name="chevron-down" size={18} />
              </button>
            ))}
          </div>
        )}
      </section>

      {selected && (
        <div
          class="drawer-layer"
          role="presentation"
          onClick$={() => (selectedId.value = "")}
        >
          <aside
            class="drawer patient-drawer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="patient-title"
            onClick$={(event) => event.stopPropagation()}
          >
            <header class="drawer-header">
              <div>
                <span class="eyebrow">Paciente</span>
                <h2 id="patient-title">{selected.name}</h2>
              </div>
              <button
                class="icon-button"
                type="button"
                aria-label="Cerrar"
                onClick$={() => (selectedId.value = "")}
              >
                <Icon name="x" size={20} />
              </button>
            </header>
            <div class="drawer-content patient-detail">
              <dl>
                <div>
                  <dt>WhatsApp</dt>
                  <dd>{whatsappIdentityLabel(selected)}</dd>
                </div>
                <div>
                  <dt>Otro teléfono</dt>
                  <dd>{selected.alternate_phone_e164 || "No informado"}</dd>
                </div>
                <div>
                  <dt>Email</dt>
                  <dd>{selected.email || "No informado"}</dd>
                </div>
                <div>
                  <dt>Cobertura</dt>
                  <dd>{coverageLabel(selected.coverage)}</dd>
                </div>
                <div>
                  <dt>¿Ya era paciente?</dt>
                  <dd>
                    {selected.is_existing_patient === null
                      ? "No informado"
                      : selected.is_existing_patient
                        ? "Sí"
                        : "No"}
                  </dd>
                </div>
                <div>
                  <dt>Próximo turno</dt>
                  <dd>
                    {selected.nextAppointment
                      ? `${formatAppointment(selected.nextAppointment.starts_at)} · ${relationName(selected.nextAppointment.services)}`
                      : "Sin próximo turno"}
                  </dd>
                </div>
                <div>
                  <dt>Último turno</dt>
                  <dd>
                    {selected.lastAppointment
                      ? `${formatAppointment(selected.lastAppointment.starts_at)} · ${relationName(selected.lastAppointment.services)}`
                      : "Sin turnos anteriores"}
                  </dd>
                </div>
                <div>
                  <dt>Notas administrativas</dt>
                  <dd>{selected.administrative_notes || "Sin notas"}</dd>
                </div>
              </dl>
              <section
                class="patient-history"
                aria-labelledby="patient-history-title"
              >
                <h3 id="patient-history-title">Historial de turnos</h3>
                {selected.appointments.length ? (
                  <ul>
                    {selected.appointments.map((appointment) => (
                      <li key={appointment.id}>
                        <span>
                          <strong>{relationName(appointment.services)}</strong>
                          <small>
                            {formatAppointment(appointment.starts_at)}
                          </small>
                        </span>
                        <span
                          class={`status-badge status-${appointmentStatusTone(
                            appointment.status,
                            effectiveDepositStatus(
                              appointment.status,
                              appointment.deposit_status,
                              appointment.hold_expires_at,
                            ),
                          )}`}
                        >
                          {appointmentDisplayStatus(
                            appointment.status,
                            effectiveDepositStatus(
                              appointment.status,
                              appointment.deposit_status,
                              appointment.hold_expires_at,
                            ),
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p class="settings-note">No hay turnos registrados.</p>
                )}
              </section>
              <div class="patient-actions">
                {selected.conversationId ? (
                  <Link
                    class="secondary-button"
                    href={`/app/inbox?conversation=${selected.conversationId}`}
                  >
                    <Icon name="message" size={17} /> Enviar WhatsApp
                  </Link>
                ) : (
                  <span class="settings-note">
                    La conversación aparecerá cuando el paciente escriba por
                    WhatsApp.
                  </span>
                )}
                <Link
                  class="primary-button"
                  href={`/app/appointments?patient=${selected.id}`}
                >
                  <Icon name="calendar" size={17} /> Crear turno
                </Link>
                <button
                  class="secondary-button"
                  type="button"
                  onClick$={() => openEditor(selected)}
                >
                  Editar datos
                </button>
              </div>
            </div>
          </aside>
        </div>
      )}

      {editorOpen.value && (
        <div
          class="drawer-layer"
          role="presentation"
          onClick$={() => (editorOpen.value = false)}
        >
          <aside
            class="drawer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="patient-editor-title"
            onClick$={(event) => event.stopPropagation()}
          >
            <header class="drawer-header">
              <div>
                <span class="eyebrow">Datos administrativos</span>
                <h2 id="patient-editor-title">
                  {editor.id ? "Editar paciente" : "Nuevo paciente"}
                </h2>
              </div>
              <button
                class="icon-button"
                type="button"
                aria-label="Cerrar"
                onClick$={() => (editorOpen.value = false)}
              >
                <Icon name="x" size={20} />
              </button>
            </header>
            <form
              class="appointment-form"
              preventdefault:submit
              onSubmit$={async () => {
                const name = editor.name.trim();
                const phone = normalizePhoneE164(editor.phone);
                const originalPatient = state.patients.find(
                  (patient) => patient.id === editor.id,
                );
                const phoneIsRequired =
                  !editor.id || Boolean(originalPatient?.phone_e164);
                if (
                  !name ||
                  (phoneIsRequired && !phone) ||
                  !editor.coverage ||
                  editor.isExistingPatient === null
                ) {
                  editor.error =
                    "Completá nombre, WhatsApp, cobertura y si ya era paciente.";
                  return;
                }
                editor.saving = true;
                editor.error = "";
                const client = getSupabaseClient();
                try {
                  if (!editor.id) {
                    const { data: existing, error: lookupError } = await client
                      .from("contacts")
                      .select("id")
                      .eq("phone_e164", phone)
                      .maybeSingle();
                    if (lookupError) throw lookupError;
                    if (existing) {
                      selectedId.value = existing.id as string;
                      editorOpen.value = false;
                      notice.value =
                        "Ese teléfono ya pertenece a un paciente. Abrimos su ficha existente.";
                      return;
                    }
                  }
                  const values = {
                    name,
                    phone_e164: phone || null,
                    email: editor.email.trim() || null,
                    administrative_notes: editor.notes.trim() || null,
                    coverage: editor.coverage,
                    is_existing_patient: editor.isExistingPatient,
                    alternate_phone_e164:
                      normalizePhoneE164(editor.alternatePhone) || null,
                  };
                  const result = editor.id
                    ? await client
                        .from("contacts")
                        .update(values)
                        .eq("id", editor.id)
                    : await client.from("contacts").insert(values);
                  if (result.error) throw result.error;
                  editorOpen.value = false;
                  selectedId.value = "";
                  reloadVersion.value += 1;
                  notice.value = editor.id
                    ? "Paciente actualizado."
                    : "Paciente creado.";
                } catch {
                  editor.error =
                    "No pudimos guardar el paciente. Revisá que el teléfono no esté duplicado.";
                } finally {
                  editor.saving = false;
                }
              }}
            >
              <label class="form-field">
                <span>Nombre y apellido</span>
                <input
                  required
                  value={editor.name}
                  onInput$={(_, element) => (editor.name = element.value)}
                />
              </label>
              <fieldset class="coverage-picker">
                <legend>Cobertura</legend>
                <div class="coverage-options">
                  {(["ioma", "particular"] as const).map((coverage) => (
                    <button
                      key={coverage}
                      class={{ selected: editor.coverage === coverage }}
                      type="button"
                      onClick$={() => (editor.coverage = coverage)}
                    >
                      {coverage === "ioma" ? "IOMA" : "Particular"}
                    </button>
                  ))}
                </div>
              </fieldset>
              <fieldset class="coverage-picker">
                <legend>¿Ya era paciente de Gisela?</legend>
                <div class="coverage-options">
                  <button
                    class={{ selected: editor.isExistingPatient === true }}
                    type="button"
                    onClick$={() => (editor.isExistingPatient = true)}
                  >
                    Sí
                  </button>
                  <button
                    class={{ selected: editor.isExistingPatient === false }}
                    type="button"
                    onClick$={() => (editor.isExistingPatient = false)}
                  >
                    No
                  </button>
                </div>
              </fieldset>
              <label class="form-field">
                <span>
                  Otro teléfono <em>Opcional</em>
                </span>
                <input
                  inputMode="tel"
                  placeholder="+54 9…"
                  value={editor.alternatePhone}
                  onInput$={(_, element) =>
                    (editor.alternatePhone = element.value)
                  }
                />
              </label>
              <label class="form-field">
                <span>Teléfono WhatsApp</span>
                <input
                  required
                  inputMode="tel"
                  placeholder="+54 9…"
                  value={editor.phone}
                  onInput$={(_, element) => (editor.phone = element.value)}
                />
              </label>
              <label class="form-field">
                <span>
                  Email <em>Opcional</em>
                </span>
                <input
                  type="email"
                  value={editor.email}
                  onInput$={(_, element) => (editor.email = element.value)}
                />
              </label>
              <label class="form-field">
                <span>
                  Notas administrativas <em>Opcional</em>
                </span>
                <textarea
                  rows={4}
                  value={editor.notes}
                  placeholder="Solo datos útiles para coordinar turnos"
                  onInput$={(_, element) => (editor.notes = element.value)}
                />
              </label>
              {editor.error && (
                <p class="login-error" role="alert">
                  {editor.error}
                </p>
              )}
              <div class="drawer-form-actions">
                <button
                  class="secondary-button"
                  type="button"
                  onClick$={() => (editorOpen.value = false)}
                >
                  Cancelar
                </button>
                <button
                  class="primary-button"
                  type="submit"
                  disabled={editor.saving}
                >
                  {editor.saving ? "Guardando…" : "Guardar paciente"}
                </button>
              </div>
            </form>
          </aside>
        </div>
      )}

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
  title: getPageTitle("Pacientes"),
  meta: [
    {
      name: "description",
      content: "Pacientes y datos administrativos de turnos.",
    },
  ],
};
