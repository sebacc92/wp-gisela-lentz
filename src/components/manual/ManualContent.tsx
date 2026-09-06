import { component$, type QRL } from "@qwik.dev/core";
import { manualSectionHref, manualSections } from "~/lib/manual-status";
import type { ManualSystemStatus } from "./SystemStatus";
import { SystemStatus } from "./SystemStatus";

interface ManualContentProps {
  systemStatus: ManualSystemStatus;
  onRefreshSystemStatus$: QRL<() => Promise<void>>;
}

export const ManualContent = component$<ManualContentProps>(
  ({ systemStatus, onRefreshSystemStatus$ }) => {
    return (
      <>
        <nav class="manual-toc" aria-label="Secciones del Manual">
          {manualSections.map((section) => (
            <a key={section.id} href={manualSectionHref(section.id)}>
              {section.label}
            </a>
          ))}
        </nav>

        <section id="primeros-pasos" class="manual-section">
          <span class="eyebrow">Primeros pasos</span>
          <h2>Qué hace esta plataforma</h2>
          <p>
            Reúne los mensajes de WhatsApp, los pacientes y la agenda en un solo
            lugar. La agenda es siempre la referencia para saber qué turno quedó
            reservado o confirmado.
          </p>
          <div class="manual-checklist">
            <div>
              <strong>Para entrar</strong>
              <p>
                Abrí la dirección habitual de la plataforma, escribí tu email y
                contraseña, y elegí <em>Ingresar</em>.
              </p>
            </div>
            <div>
              <strong>Para salir</strong>
              <p>
                Elegí <em>Cerrar sesión</em> en la barra lateral antes de dejar
                una computadora compartida.
              </p>
            </div>
            <div>
              <strong>Si olvidaste la contraseña</strong>
              <p>
                Escribí tu email en la pantalla de ingreso y elegí
                <em> ¿Olvidaste tu contraseña?</em>. Si la cuenta existe, vas a
                recibir un enlace personal para elegir una nueva. No compartas
                ese enlace ni tu contraseña.
              </p>
            </div>
          </div>
        </section>

        <section id="whatsapp" class="manual-section">
          <span class="eyebrow">WhatsApp</span>
          <h2>Cómo atender conversaciones</h2>
          <p>
            En <strong>Mensajes</strong> vas a ver cada conversación. Si una
            necesita tu intervención, aparece marcada como pendiente. Abrila,
            leé el contexto y respondé desde la misma pantalla cuando el envío
            esté permitido.
          </p>
          <div class="manual-two-columns">
            <div>
              <h3>Atención automática</h3>
              <p>
                Cuando está activa, ayuda a orientar pedidos simples de turnos.
                También puede autoconfirmar una pre-reserva con una comprobación
                básica si habilitaste la lectura de medios. Las urgencias, los
                casos dudosos y los pedidos complejos quedan para tu revisión.
              </p>
            </div>
            <div>
              <h3>Atención personal</h3>
              <p>
                Elegí <strong>Pausar bot</strong> para tomar una conversación.
                Cuando termines, elegí <strong>Reactivar bot</strong> sólo si
                corresponde que vuelva a atender automáticamente.
              </p>
            </div>
          </div>
          <p class="manual-callout">
            <strong>Ventana de 24 horas.</strong> Después de un mensaje del
            paciente, se puede responder texto libre por un tiempo limitado. Si
            ese plazo cerró, la plataforma bloquea el texto libre para proteger
            la cuenta; puede hacer falta una plantilla aprobada.
          </p>
        </section>

        <section id="turnos" class="manual-section">
          <span class="eyebrow">Turnos</span>
          <h2>Ver, crear y cambiar la agenda</h2>
          <ol class="manual-steps">
            <li>
              Abrí <strong>Agenda</strong> para ver el día elegido. Usá las
              flechas para cambiar de fecha.
            </li>
            <li>
              Para crear un turno, elegí <strong>Nuevo turno</strong>, buscá o
              creá a la persona y seleccioná un horario disponible.
            </li>
            <li>
              Para editar o reprogramar, abrí el turno y seguí la opción
              correspondiente. Confirmá siempre la nueva fecha antes de cerrar.
            </li>
            <li>
              Para cancelar o marcar como atendido, elegí el estado correcto y
              revisá el aviso de confirmación antes de aceptarlo.
            </li>
          </ol>
          <p>
            Si un horario ya no aparece, puede estar ocupado, bloqueado o fuera
            del horario de atención. No prometas un turno hasta verlo guardado
            en la agenda.
          </p>
        </section>

        <section id="pacientes" class="manual-section">
          <span class="eyebrow">Pacientes</span>
          <h2>Buscar y actualizar datos administrativos</h2>
          <p>
            En <strong>Pacientes</strong> podés buscar por nombre, teléfono o
            email. Mantené actualizados los datos de contacto, si ya era
            paciente y la cobertura: <strong>IOMA</strong> o
            <strong> Particular</strong>.
          </p>
          <p>
            Gisela atiende únicamente por IOMA o de forma particular. Si alguien
            tiene otra obra social, confirmá que acepta atenderse de forma
            particular antes de registrarlo así.
          </p>
          <p>
            La ficha es administrativa. No cargues diagnósticos, recetas ni
            información clínica sensible en las notas de esta plataforma.
          </p>
        </section>

        <section id="senas" class="manual-section">
          <span class="eyebrow">Señas</span>
          <h2>Qué hacer con un comprobante</h2>
          <p>
            Una reserva puede quedar como <strong>Esperando seña</strong>. Si
            habilitaste la lectura de medios, una imagen o un PDF se envía
            temporalmente a OpenAI con <code>store=false</code> para extraer
            monto, moneda, fecha, destino, titular e identificador de la
            operación. El modelo no valida el comprobante ni concilia la
            transferencia con un banco.
          </p>
          <p>
            <code>store=false</code> evita que Responses conserve estado de la
            solicitud. OpenAI puede mantener registros de prevención de abuso
            con contenido por hasta 30 días, salvo que el proyecto tenga Zero
            Data Retention habilitado.
          </p>
          <ol class="manual-steps">
            <li>
              Una regla básica local de la base de datos puede autoconfirmar
              sólo la pre-reserva exacta asociada al mensaje cuando el archivo
              es legible y se leen el monto exacto y el alias o titular. Moneda,
              fecha e identificador quedan como datos auxiliares y no bloquean.
            </li>
            <li>
              Revisá los casos que no cumplen la regla. Si el comprobante llegó
              después del vencimiento, buscá un nuevo horario y generá otra
              pre-reserva: el turno vencido no se puede confirmar.
            </li>
            <li>
              Podés revisar cualquier turno autoconfirmado y cancelarlo después
              si encontrás una diferencia.
            </li>
          </ol>
          <p class="manual-callout">
            La plataforma conserva la lectura extraída, el hash, la evidencia
            técnica y la auditoría, pero no persiste localmente los bytes de la
            imagen o del PDF.
          </p>
        </section>

        <section id="calendario" class="manual-section">
          <span class="eyebrow">Calendario</span>
          <h2>Cómo se sincroniza la agenda</h2>
          <p>
            Estar conectado no significa que la sincronización automática esté
            activa. Sólo cuando el estado lo confirma, las pre-reservas nuevas
            creadas después de la activación aparecen como pendientes de seña y,
            al confirmarlas, el mismo evento pasa a turno confirmado. La agenda
            de esta plataforma sigue siendo la fuente de verdad: si hay una
            diferencia, verificá primero el turno acá.
          </p>
          <p>
            Si el estado indica que Google Calendar necesita atención, no borres
            eventos a ciegas. Revisá{" "}
            <strong>Configuración → Google Calendar</strong>; si continúa el
            aviso, contactá a Sebastián.
          </p>
        </section>

        <section id="automatizacion" class="manual-section">
          <span class="eyebrow">Atención automática</span>
          <h2>Una ayuda, no un reemplazo</h2>
          <p>
            La atención automática guía pasos repetitivos, como pedir un turno,
            consultar horarios o iniciar una reprogramación. Se detiene cuando
            una persona toma la conversación, cuando hay una urgencia o cuando
            un comprobante necesita revisión manual. Un comprobante que cumple
            la regla básica puede confirmar automáticamente la pre-reserva
            exacta.
          </p>
          <p>
            Antes de activarla para uso cotidiano, revisá horarios, servicios,
            duraciones, señas, mensajes y modo de envío en
            <strong> Configuración</strong>.
          </p>
        </section>

        <section id="problemas-frecuentes" class="manual-section">
          <span class="eyebrow">Problemas frecuentes</span>
          <h2>Qué revisar antes de pedir ayuda</h2>
          <div class="manual-problems">
            <article>
              <h3>No responde WhatsApp</h3>
              <p>
                <strong>Qué significa:</strong> puede estar pausado, sin
                conexión o fuera de la ventana para texto libre.{" "}
                <strong>Qué revisar:</strong> el estado de WhatsApp y la
                conversación.
                <strong> Qué hacer:</strong> no repitas envíos; actualizá el
                estado y abrí la conversación.{" "}
                <strong>Cuándo llamar a Sebastián:</strong> si el estado no se
                actualiza o aparece una alerta persistente.
              </p>
            </article>
            <article>
              <h3>Un paciente quedó esperando</h3>
              <p>
                <strong>Qué significa:</strong> necesita atención humana o una
                decisión sobre su turno. <strong>Qué revisar:</strong> el último
                mensaje, el estado de la seña y la agenda.
                <strong> Qué hacer:</strong> filtrá Mensajes por pendientes y
                respondé personalmente.{" "}
                <strong>Cuándo llamar a Sebastián:</strong>
                si la conversación no se puede abrir o guardar.
              </p>
            </article>
            <article>
              <h3>El comprobante no se reconoció</h3>
              <p>
                <strong>Qué significa:</strong> puede haber llegado fuera de la
                reserva, ser ilegible, no cumplir la regla básica o no tener un
                turno asociado. <strong>Qué revisar:</strong> la conversación,
                el turno y el archivo recibido. <strong> Qué hacer:</strong>{" "}
                revisá el caso; si la reserva sigue activa, confirmá sólo si
                corresponde. Si venció, buscá un nuevo horario y generá otra
                pre-reserva. <strong>Cuándo llamar a Sebastián:</strong> si el
                archivo no aparece o el turno correcto no se puede encontrar.
              </p>
            </article>
            <article>
              <h3>El turno no apareció</h3>
              <p>
                <strong>Qué significa:</strong> el guardado puede no haberse
                completado o se está mirando otro día.{" "}
                <strong>Qué revisar:</strong>
                la fecha elegida, la persona y el estado del turno.
                <strong> Qué hacer:</strong> actualizá la agenda y buscá a la
                persona. <strong>Cuándo llamar a Sebastián:</strong> si no
                aparece luego de volver a entrar.
              </p>
            </article>
            <article>
              <h3>Quiero atender personalmente</h3>
              <p>
                <strong>Qué significa:</strong> la conversación necesita una
                decisión humana. <strong>Qué revisar:</strong> el último mensaje
                y el estado del turno, si lo hubiera.
                <strong> Qué hacer:</strong> abrí Mensajes y elegí
                <strong> Pausar bot</strong>. Cuando termines, reanudalo sólo si
                corresponde. <strong>Cuándo llamar a Sebastián:</strong> si el
                botón no cambia el estado de la conversación.
              </p>
            </article>
            <article>
              <h3>Quiero cambiar horarios, señas o servicios</h3>
              <p>
                <strong>Qué significa:</strong> son reglas que afectan los
                próximos turnos. <strong>Qué revisar:</strong> la decisión de
                Gisela antes de guardar. <strong>Qué hacer:</strong> abrí
                Configuración y elegí la sección correspondiente. Los cambios
                estructurales requieren una administradora.{" "}
                <strong>Cuándo llamar a Sebastián:</strong> si no tenés permiso
                o no estás segura de la consecuencia del cambio.
              </p>
            </article>
            <article>
              <h3>Quiero cambiar el monto de la seña</h3>
              <p>
                <strong>Qué significa:</strong> cambia la información que se usa
                para las próximas reservas. <strong>Qué revisar:</strong>
                monto, alias, titular y plazo confirmados por Gisela.
                <strong> Qué hacer:</strong> abrí Configuración → WhatsApp y
                reservas, actualizá los datos y guardá una sola vez.
                <strong> Cuándo llamar a Sebastián:</strong> si una reserva ya
                creada muestra datos distintos o el cambio no se guarda.
              </p>
            </article>
            <article>
              <h3>Un paciente canceló</h3>
              <p>
                <strong>Qué significa:</strong> el turno ya no debe quedar
                disponible como confirmado. <strong>Qué revisar:</strong> la
                fecha, la persona y si existe una seña o comprobante.
                <strong> Qué hacer:</strong> abrí el turno en Agenda y elegí
                <strong> Cancelar</strong>; después respondé al paciente si
                corresponde. <strong>Cuándo llamar a Sebastián:</strong> si no
                encontrás el turno o el estado no se actualiza.
              </p>
            </article>
            <article>
              <h3>Google Calendar no refleja un turno</h3>
              <p>
                <strong>Qué significa:</strong> la sincronización puede estar
                pendiente o necesitar una nueva conexión.{" "}
                <strong>Qué revisar:</strong>
                primero que el turno esté bien en la agenda y luego el estado de
                Calendar. <strong>Qué hacer:</strong> no dupliques el turno
                manualmente sin comprobarlo.{" "}
                <strong>Cuándo llamar a Sebastián:</strong> si el aviso de
                Calendar necesita atención o no se actualiza.
              </p>
            </article>
          </div>
        </section>

        <SystemStatus
          status={systemStatus}
          onRefresh$={onRefreshSystemStatus$}
        />
      </>
    );
  },
);
