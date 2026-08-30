import { component$ } from "@qwik.dev/core";
import type { DocumentHead } from "@qwik.dev/router";
import { LegalPage } from "~/components/legal/LegalPage";
import { BUSINESS_CONFIG, getPageTitle } from "~/config/business";

export default component$(() => {
  return (
    <LegalPage
      current="privacy"
      eyebrow="Información legal"
      title="Política de privacidad"
      intro="Esta política explica de manera simple qué información puede procesar la plataforma, para qué se utiliza y qué opciones tienen las personas sobre sus datos."
    >
      <section>
        <h2>1. Alcance y responsable</h2>
        <p>
          Esta política se aplica a la plataforma de {BUSINESS_CONFIG.name} para
          la gestión de comunicaciones mediante WhatsApp Business, contactos,
          conversaciones, turnos, sincronización opcional con Google Calendar y
          automatizaciones administrativas.
        </p>
        <p>
          El responsable del tratamiento es la persona u organización que opera
          esta plataforma y el perfil oficial de WhatsApp Business asociado. Su
          identificación y sus datos de soporte son los que se encuentran
          publicados en ese perfil comercial. {BUSINESS_CONFIG.name} identifica
          al servicio dentro de esta plataforma.
        </p>
      </section>

      <section>
        <h2>2. Datos que pueden procesarse</h2>
        <p>Según la forma en que se utilice el servicio, podemos procesar:</p>
        <ul>
          <li>
            <strong>Datos de contacto:</strong> nombre, número de teléfono,
            identificador de WhatsApp y datos visibles del perfil que WhatsApp
            entregue a la cuenta comercial.
          </li>
          <li>
            <strong>Conversaciones:</strong> contenido de los mensajes enviados
            y recibidos, archivos o referencias a archivos cuando corresponda,
            incluidos los comprobantes que la persona decida enviar para que el
            consultorio revise una seña, además de la fecha, hora y estado de
            entrega o lectura.
          </li>
          <li>
            <strong>Datos de turnos:</strong> la información administrativa
            necesaria para solicitar, asignar, confirmar, reprogramar o cancelar
            un turno, como cobertura, profesional, fecha, horario, duración,
            estado de la reserva y estado de revisión de la seña.
          </li>
          <li>
            <strong>Copia en Google Calendar:</strong> si una persona
            administradora conecta esta función, se copia el nombre del
            paciente, la fecha y el horario del turno a un calendario privado
            del consultorio. No se copian el teléfono, notas internas, motivo
            clínico, comprobantes ni otros archivos, y no se agrega al paciente
            como invitado.
          </li>
          <li>
            <strong>Información clínica odontológica:</strong> el odontograma
            registra el estado de cada pieza dental, las caras afectadas y notas
            del tratamiento. Lo carga la profesional durante la atención; no se
            recibe por WhatsApp. Es un dato de salud y se trata como tal: sólo
            accede el rol administrador, cada registro queda con su fecha y
            autor, ninguno se modifica ni se elimina, y la automatización de
            mensajes nunca lo consulta ni lo envía.
          </li>
          <li>
            <strong>Preferencias y consentimiento:</strong> constancias de alta,
            baja o autorización para comunicaciones y recordatorios.
          </li>
          <li>
            <strong>Datos técnicos y de seguridad:</strong> identificadores de
            mensajes, eventos de integración, registros de auditoría, errores y
            datos necesarios para prevenir abuso o investigar incidentes.
          </li>
        </ul>
        <p>
          La información puede ser proporcionada por la propia persona, por el
          personal autorizado que gestiona el servicio o por Meta al transmitir
          una interacción de WhatsApp. No es necesario enviar diagnósticos,
          historias clínicas, contraseñas, códigos de seguridad, credenciales
          bancarias ni datos completos de una cuenta por este canal. Si se
          solicita una seña, el comprobante se utiliza únicamente para revisión
          administrativa humana: la plataforma no valida transferencias ni
          acredita pagos automáticamente.
        </p>
      </section>

      <section>
        <h2>3. Para qué usamos los datos</h2>
        <p>
          Los datos se utilizan únicamente para finalidades vinculadas al
          servicio:
        </p>
        <ul>
          <li>recibir, organizar y responder consultas por WhatsApp;</li>
          <li>gestionar solicitudes y cambios de turnos;</li>
          <li>
            mantener una pre-reserva temporal y permitir que personal autorizado
            revise y confirme una seña;
          </li>
          <li>
            mantener una copia administrativa de los turnos en el Google
            Calendar privado que el consultorio decida conectar;
          </li>
          <li>
            enviar confirmaciones o recordatorios administrativos cuando exista
            la autorización necesaria;
          </li>
          <li>
            derivar la conversación a una persona cuando la automatización no
            sea suficiente;
          </li>
          <li>
            mantener la seguridad, evitar duplicados, solucionar fallas y
            cumplir obligaciones aplicables.
          </li>
        </ul>
        <p>
          No usamos los datos para venderlos ni los comercializamos con
          terceros. Tampoco se utilizan para enviar promociones no solicitadas.
        </p>
      </section>

      <section>
        <h2>4. Supabase, Meta, OpenAI, Google y otros proveedores</h2>
        <p>
          La información operativa de la plataforma se almacena en Supabase, que
          provee infraestructura de base de datos, autenticación y servicios
          relacionados. Se aplican controles de acceso para limitar el uso de la
          información al personal y a los procesos autorizados.
        </p>
        <p>
          Los mensajes se reciben y envían mediante la WhatsApp Cloud API de
          Meta. Por eso, Meta y WhatsApp procesan los datos necesarios para
          transportar los mensajes y prestar sus servicios conforme a sus
          propias políticas. También puede intervenir el proveedor de
          alojamiento técnico de la aplicación.
        </p>
        <p>
          Si el consultorio habilita el asistente administrativo opcional,
          OpenAI puede procesar una pregunta canónica sobre horarios o
          ubicación, la dirección y las reglas estructuradas de horarios del
          consultorio, y un identificador técnico seudónimo. No se le envían el
          mensaje original, nombre o teléfono del paciente, cobertura, turnos,
          comprobantes ni información clínica. La solicitud se realiza con
          almacenamiento desactivado y, ante una duda, la conversación se deriva
          a una persona.
        </p>
        <p>
          Si el consultorio habilita Google Calendar, Google procesa la copia
          administrativa de nombre, fecha y horario necesaria para mostrar los
          turnos en un calendario privado. La conexión puede revocarse desde la
          plataforma. Desconectarla detiene las sincronizaciones futuras, pero
          los eventos ya copiados permanecen en ese calendario hasta que su
          titular los elimine.
        </p>
        <p>
          Estos proveedores pueden procesar información en los lugares donde
          operan su infraestructura, con las salvaguardas y condiciones que les
          resulten aplicables. Podés consultar la
          <a
            href="https://supabase.com/privacy"
            target="_blank"
            rel="noreferrer"
          >
            política de privacidad de Supabase
          </a>
          , la
          <a
            href="https://www.whatsapp.com/legal/privacy-policy"
            target="_blank"
            rel="noreferrer"
          >
            política de privacidad de WhatsApp
          </a>
          y la
          <a
            href="https://www.facebook.com/privacy/policy/"
            target="_blank"
            rel="noreferrer"
          >
            política de privacidad de Meta
          </a>
          , y la
          <a
            href="https://openai.com/policies/privacy-policy/"
            target="_blank"
            rel="noreferrer"
          >
            política de privacidad de OpenAI
          </a>
          , y la
          <a
            href="https://policies.google.com/privacy"
            target="_blank"
            rel="noreferrer"
          >
            política de privacidad de Google
          </a>
          .
        </p>
      </section>

      <section>
        <h2>5. Conservación y seguridad</h2>
        <p>
          Conservamos los datos durante el tiempo necesario para gestionar el
          servicio, proteger su seguridad y atender obligaciones legales o
          reclamos. Cuando dejan de ser necesarios, se eliminan o anonimizan de
          acuerdo con los procedimientos técnicos aplicables. Las copias de
          respaldo pueden tardar un tiempo adicional en expirar.
        </p>
        <p>
          Aplicamos medidas razonables de seguridad, como control de acceso,
          autenticación, trazabilidad y validación de las comunicaciones con los
          servicios externos. Ningún sistema conectado a Internet puede ofrecer
          seguridad absoluta.
        </p>
      </section>

      <section>
        <h2>6. Derechos y opciones</h2>
        <p>
          De acuerdo con la normativa aplicable, podés solicitar acceso,
          corrección, actualización, eliminación o limitación del uso de tus
          datos, así como retirar un consentimiento otorgado. También podés
          oponerte a comunicaciones futuras.
        </p>
        <p>
          Enviar <strong>“BAJA”</strong> por el chat detiene las comunicaciones
          proactivas, pero no equivale por sí solo a eliminar el historial. Para
          solicitar una eliminación, seguí las
          <a href="/data-deletion"> instrucciones de eliminación de datos</a>.
        </p>
      </section>

      <section>
        <h2>7. Contacto de privacidad</h2>
        <p>
          Escribí al mismo número oficial de WhatsApp Business mediante el cual
          te comunicaste con el servicio y enviá
          <strong> “SOLICITUD DE PRIVACIDAD”</strong>. También podés utilizar
          los datos de soporte que figuren en el perfil comercial de ese número.
          No envíes contraseñas, códigos de verificación ni documentación
          sensible.
        </p>
      </section>

      <section>
        <h2>8. Cambios a esta política</h2>
        <p>
          Esta política puede actualizarse para reflejar cambios en la
          plataforma, en sus proveedores o en los requisitos aplicables. La
          versión vigente se publicará siempre en esta página con su fecha de
          actualización.
        </p>
      </section>
    </LegalPage>
  );
});

export const head: DocumentHead = {
  title: getPageTitle("Política de privacidad"),
  meta: [
    {
      name: "description",
      content: `Cómo ${BUSINESS_CONFIG.name} procesa datos de contacto, mensajes de WhatsApp y datos administrativos de turnos.`,
    },
    { name: "robots", content: "index, follow" },
  ],
};
