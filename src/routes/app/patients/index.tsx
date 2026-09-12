import {
  $,
  component$,
  useContext,
  useSignal,
  useStore,
  useVisibleTask$,
} from "@qwik.dev/core";
import type { DocumentHead } from "@qwik.dev/router";
import { Link, useLocation } from "@qwik.dev/router";
import { AppNavigation } from "~/components/app/AppNavigation";
import { APP_USER_CONTEXT } from "~/components/app/AppUserContext";
import { DuplicateAssistant } from "~/components/patients/DuplicateAssistant";
import { PatientAttachments } from "~/components/patients/PatientAttachments";
import { ManualHelpLink } from "~/components/app/ManualHelpLink";
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
import { foldForSearch } from "~/lib/message-search";
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
  responsible_contact_id: string | null;
}

interface AppointmentRow {
  id: string;
  contact_id: string;
  patient_contact_id: string | null;
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

const DEPOSIT_LABELS: Record<DepositStatus, string> = {
  not_required: "No requerida",
  pending: "Esperando seña",
  proof_received: "Comprobante recibido",
  confirmed: "Confirmada",
  expired: "Vencida",
};

function depositLabel(appointment: AppointmentRow): string {
  return DEPOSIT_LABELS[
    effectiveDepositStatus(
      appointment.status,
      appointment.deposit_status,
      appointment.hold_expires_at,
    )
  ];
}

function whatsappIdentityLabel(patient: PatientRow): string {
  if (patient.phone_e164) return patient.phone_e164;
  // Una ficha a cargo de otro contacto no necesita WhatsApp propio.
  if (!patient.whatsapp_user_id && patient.responsible_contact_id) {
    return "Sin WhatsApp propio";
  }
  return "Identidad privada de WhatsApp";
}

export default component$(() => {
  const appUser = useContext(APP_USER_CONTEXT);
  const location = useLocation();
  const patientTab = useSignal<
    "datos" | "turnos" | "clinico" | "adjuntos" | "pagos"
  >("datos");
  const printingId = useSignal("");
  const duplicatesOpen = useSignal(false);
  const query = useSignal("");
  // La búsqueda global (Ctrl/⌘ + K) entra directo a un paciente por URL.
  const selectedId = useSignal(location.url.searchParams.get("patient") ?? "");
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
              "id,name,phone_e164,whatsapp_user_id,email,administrative_notes,created_at,coverage,is_existing_patient,alternate_phone_e164,responsible_contact_id",
            )
            // Una ficha fusionada sigue existiendo para que las referencias
            // históricas resuelvan, pero no se ofrece: su paciente es la principal.
            .is("merged_into_contact_id", null)
            .order("name"),
          client
            .from("appointments")
            .select(
              "id,contact_id,patient_contact_id,starts_at,status,deposit_status,hold_expires_at,services!appointments_service_id_fkey(name)",
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
          // El turno figura en la ficha de quien se atiende, no en la de quien
          // lo gestiona por WhatsApp.
          const patientAppointments = appointments.filter(
            (appointment) =>
              (appointment.patient_contact_id ?? appointment.contact_id) ===
              patient.id,
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
            (item) =>
              item.contact_id ===
                (patient.responsible_contact_id ?? patient.id) &&
              item.status === "open",
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

  // Sin acentos: «perez» encuentra a «Pérez».
  const normalizedQuery = foldForSearch(query.value.trim());
  const patients = state.patients.filter(
    (patient) =>
      !normalizedQuery ||
      foldForSearch(patient.name).includes(normalizedQuery) ||
      patient.phone_e164?.includes(normalizedQuery) ||
      patient.whatsapp_user_id?.includes(normalizedQuery) ||
      patient.alternate_phone_e164?.includes(normalizedQuery) ||
      (patient.email
        ? foldForSearch(patient.email).includes(normalizedQuery)
        : false),
  );
  const selected = state.patients.find(
    (patient) => patient.id === selectedId.value,
  );
  // Sólo los turnos donde la seña dice algo: el resto no es un registro de pago.
  const depositHistory = (selected?.appointments ?? []).filter(
    (appointment) => appointment.deposit_status !== "not_required",
  );
  const printingPatient = state.patients.find(
    (patient) => patient.id === printingId.value,
  );
  const editorOriginalPatient = state.patients.find(
    (patient) => patient.id === editor.id,
  );
  const editorPhoneIsRequired =
    !editor.id || Boolean(editorOriginalPatient?.phone_e164);

  return (
    <main class="section-shell">
      <AppNavigation active="patients" />
      <section
        id="app-content"
        class="section-page patients-page"
        tabIndex={-1}
      >
        <header class="section-page-header">
          <div>
            <span class="eyebrow">Agenda administrativa</span>
            <h1>Pacientes</h1>
            <p>
              Datos de contacto y turnos. La información clínica se carga desde
              Odontograma.
            </p>
          </div>
          <div class="patients-header-actions">
            <ManualHelpLink section="pacientes" label="¿Cómo usar pacientes?" />
            <button
              class="secondary-button"
              type="button"
              onClick$={() => (duplicatesOpen.value = true)}
            >
              <Icon name="search" size={17} /> Buscar duplicados
            </button>
            <button
              class="primary-button"
              type="button"
              onClick$={() => openEditor()}
            >
              <Icon name="plus" size={17} /> Nuevo paciente
            </button>
          </div>
        </header>

        <label class="search-field patients-search">
          <Icon name="search" size={18} />
          <span class="sr-only">Buscar paciente</span>
          <input
            type="search"
            value={query.value}
            placeholder="Buscar por nombre, teléfono o email"
            autoComplete="off"
            enterKeyHint="search"
            onInput$={(_, element) => (query.value = element.value)}
          />
          {query.value && (
            <button
              class="search-clear"
              type="button"
              aria-label="Limpiar búsqueda"
              title="Limpiar búsqueda"
              onClick$={() => (query.value = "")}
            >
              <Icon name="x" size={16} />
            </button>
          )}
        </label>

        {query.value && !state.loading && !state.error && (
          <p class="search-result-summary" aria-live="polite">
            {patients.length === 1
              ? "1 paciente encontrado"
              : `${patients.length} pacientes encontrados`}
          </p>
        )}

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
            stoppropagation:click
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
              <nav
                class="patient-tabs"
                role="tablist"
                aria-label="Ficha del paciente"
              >
                {(
                  [
                    ["datos", "Datos"],
                    ["turnos", "Turnos"],
                    ["clinico", "Odontograma"],
                    ["adjuntos", "Adjuntos"],
                    ["pagos", "Señas"],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    role="tab"
                    class={{ active: patientTab.value === key }}
                    aria-selected={patientTab.value === key}
                    onClick$={() => (patientTab.value = key)}
                  >
                    {label}
                  </button>
                ))}
              </nav>

              {patientTab.value === "datos" && (
                <dl>
                  <div>
                    <dt>WhatsApp</dt>
                    <dd>{whatsappIdentityLabel(selected)}</dd>
                  </div>
                  {selected.responsible_contact_id && (
                    <div>
                      <dt>A cargo de</dt>
                      <dd>
                        {state.patients.find(
                          (patient) =>
                            patient.id === selected.responsible_contact_id,
                        )?.name ?? "Otro contacto de WhatsApp"}
                      </dd>
                    </div>
                  )}
                  {state.patients.some(
                    (patient) => patient.responsible_contact_id === selected.id,
                  ) && (
                    <div>
                      <dt>Personas a cargo</dt>
                      <dd>
                        {state.patients
                          .filter(
                            (patient) =>
                              patient.responsible_contact_id === selected.id,
                          )
                          .map((patient) => patient.name)
                          .join(", ")}
                      </dd>
                    </div>
                  )}
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
              )}

              {patientTab.value === "turnos" && (
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
                            <strong>
                              {relationName(appointment.services)}
                            </strong>
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
              )}

              {patientTab.value === "clinico" && (
                <section class="patient-clinical">
                  <h3>Odontograma</h3>
                  <p class="settings-note">
                    La historia clínica se carga y se consulta en su propia
                    pantalla: es append-only y sólo la ve una persona
                    administradora.
                  </p>
                  <Link
                    class="secondary-button"
                    href={`/app/odontogram?patient=${selected.id}`}
                  >
                    <Icon name="smile" size={17} /> Abrir el odontograma
                  </Link>
                </section>
              )}

              {patientTab.value === "adjuntos" && (
                <section class="patient-clinical">
                  <h3>Estudios y documentos</h3>
                  <PatientAttachments
                    contactId={selected.id}
                    isAdmin={appUser.isAdmin}
                  />
                </section>
              )}

              {patientTab.value === "pagos" && (
                <section class="patient-history">
                  <h3>Señas por turno</h3>
                  {depositHistory.length ? (
                    <ul>
                      {depositHistory.map((appointment) => (
                        <li key={appointment.id}>
                          <span>
                            <strong>
                              {relationName(appointment.services)}
                            </strong>
                            <small>
                              {formatAppointment(appointment.starts_at)}
                            </small>
                          </span>
                          <span class="status-badge">
                            {depositLabel(appointment)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p class="settings-note">
                      Ningún turno de este paciente requirió seña.
                    </p>
                  )}
                </section>
              )}

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
                <button
                  class="secondary-button"
                  type="button"
                  onClick$={() => {
                    printingId.value = selected.id;
                    // El navegador imprime la hoja recién cuando existe en el
                    // documento, así que se espera un cuadro.
                    requestAnimationFrame(() =>
                      requestAnimationFrame(() => window.print()),
                    );
                  }}
                >
                  <Icon name="printer" size={17} /> Exportar ficha
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
            stoppropagation:click
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
                if (
                  !name ||
                  (editorPhoneIsRequired && !phone) ||
                  !editor.coverage ||
                  editor.isExistingPatient === null
                ) {
                  editor.error = editorPhoneIsRequired
                    ? "Completá nombre, WhatsApp, cobertura y si ya era paciente."
                    : "Completá nombre, cobertura y si ya era paciente.";
                  return;
                }
                editor.saving = true;
                editor.error = "";
                const client = getSupabaseClient();
                try {
                  if (!editor.id) {
                    const { data: existing, error: lookupError } = await client
                      .from("contacts")
                      .select("id,merged_into_contact_id")
                      .eq("phone_e164", phone)
                      .maybeSingle();
                    if (lookupError) throw lookupError;
                    if (existing) {
                      // Si el teléfono es de una ficha fusionada, la ficha
                      // que vale es aquella en la que se unió.
                      selectedId.value = (existing.merged_into_contact_id ??
                        existing.id) as string;
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
                <div
                  class="coverage-options"
                  role="group"
                  aria-label="Cobertura"
                >
                  {(["ioma", "particular"] as const).map((coverage) => (
                    <button
                      key={coverage}
                      class={{ selected: editor.coverage === coverage }}
                      type="button"
                      aria-pressed={editor.coverage === coverage}
                      onClick$={() => (editor.coverage = coverage)}
                    >
                      {coverage === "ioma" ? "IOMA" : "Particular"}
                    </button>
                  ))}
                </div>
              </fieldset>
              <fieldset class="coverage-picker">
                <legend>¿Ya era paciente de Gisela?</legend>
                <div
                  class="coverage-options"
                  role="group"
                  aria-label="Paciente previo"
                >
                  <button
                    class={{ selected: editor.isExistingPatient === true }}
                    type="button"
                    aria-pressed={editor.isExistingPatient === true}
                    onClick$={() => (editor.isExistingPatient = true)}
                  >
                    Sí
                  </button>
                  <button
                    class={{ selected: editor.isExistingPatient === false }}
                    type="button"
                    aria-pressed={editor.isExistingPatient === false}
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
                <span>
                  Teléfono WhatsApp
                  {!editorPhoneIsRequired && <em>Opcional en esta ficha</em>}
                </span>
                <input
                  required={editorPhoneIsRequired}
                  inputMode="tel"
                  placeholder="+54 9…"
                  value={editor.phone}
                  aria-describedby={
                    editorPhoneIsRequired ? undefined : "legacy-phone-help"
                  }
                  onInput$={(_, element) => (editor.phone = element.value)}
                />
                {!editorPhoneIsRequired && (
                  <small id="legacy-phone-help" class="form-field-help">
                    Podés agregarlo más adelante si la persona usa WhatsApp.
                  </small>
                )}
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

      {duplicatesOpen.value && (
        <DuplicateAssistant
          isAdmin={appUser.isAdmin}
          candidates={state.patients.map((patient) => ({
            id: patient.id,
            name: patient.name,
            phoneE164: patient.phone_e164,
            alternatePhoneE164: patient.alternate_phone_e164,
            createdAt: patient.created_at,
            appointmentCount: patient.appointments.length,
            // El odontograma es de ADMIN y no se carga en esta pantalla; la
            // base vuelve a verificarlo y rechaza la fusión si existe.
            hasClinicalHistory: false,
          }))}
          onClose$={$(() => (duplicatesOpen.value = false))}
          onMerged$={$((message: string) => {
            duplicatesOpen.value = false;
            notice.value = message;
            reloadVersion.value += 1;
          })}
        />
      )}

      {printingPatient && (
        <section class="patient-print-sheet" aria-hidden="true">
          <header>
            <h1>Ficha de {printingPatient.name}</h1>
            <p>
              {whatsappIdentityLabel(printingPatient)} ·{" "}
              {coverageLabel(printingPatient.coverage)}
            </p>
          </header>
          <h2>Turnos</h2>
          {printingPatient.appointments.length ? (
            <table>
              <thead>
                <tr>
                  <th scope="col">Fecha</th>
                  <th scope="col">Motivo</th>
                  <th scope="col">Estado</th>
                  <th scope="col">Seña</th>
                </tr>
              </thead>
              <tbody>
                {printingPatient.appointments.map((appointment) => (
                  <tr key={appointment.id}>
                    <td>{formatAppointment(appointment.starts_at)}</td>
                    <td>{relationName(appointment.services)}</td>
                    <td>
                      {appointmentDisplayStatus(
                        appointment.status,
                        effectiveDepositStatus(
                          appointment.status,
                          appointment.deposit_status,
                          appointment.hold_expires_at,
                        ),
                      )}
                    </td>
                    <td>{depositLabel(appointment)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p>Sin turnos registrados.</p>
          )}
          <p class="patient-print-note">
            Resumen administrativo. No incluye la historia clínica: el
            odontograma se exporta desde su propia pantalla.
          </p>
        </section>
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
